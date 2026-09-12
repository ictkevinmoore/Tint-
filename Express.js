const express = require('express');
const { urlencoded } = require('body-parser');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js'); // Example DB client

const app = express();
app.use(urlencoded({ extended: false }));

// Initialize your database (e.g., Supabase, Prisma, or MongoDB)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// The Twilio webhook endpoint
// twilio.webhook() middleware automatically validates the X-Twilio-Signature
app.post('/api/webhook/twilio', twilio.webhook({ validate: true }), async (req, res) => {
  try {
    const inboundPhone = req.body.From;
    const messageBody = req.body.Body;
    const mediaUrl = req.body.MediaUrl0; // Captures the first image attachment if present

    // 1. Find the lead in your CRM database based on their phone number
    const { data: lead } = await supabase
      .from('leads')
      .select('id, status, name')
      .eq('phone', inboundPhone)
      .single();

    if (lead) {
      // 2. Halt the automated follow-up sequence
      // If they reply, we must stop the "two times per day for 3 days" drip
      if (lead.status === 'Nurture Active') {
        await supabase
          .from('leads')
          .update({ status: 'Manual Reply', drip_active: false })
          .eq('id', lead.id);
      }

      // 3. Save the new inbound message to the conversation history
      const { data: newMessage } = await supabase
        .from('messages')
        .insert({
          lead_id: lead.id,
          direction: 'inbound',
          body: messageBody,
          media_url: mediaUrl,
          timestamp: new Date()
        })
        .select()
        .single();

      // 4. Push to React front-end
      // If using WebSockets (Socket.io) or an event bus:
      // io.emit('new_message', { leadId: lead.id, message: newMessage });
      
    } else {
      // Handle net-new inbound leads (e.g., someone texted your number directly)
      // Logic to create a new lead profile goes here
    }

    // Twilio expects an XML response (TwiML) acknowledging receipt.
    // An empty <Response></Response> tells Twilio we received it and no auto-reply is needed here.
    const twiml = new twilio.twiml.MessagingResponse();
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Server Error');
  }
});

app.listen(3000, () => console.log('Webhook server running on port 3000'));
