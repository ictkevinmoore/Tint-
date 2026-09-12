const cron = require('node-cron');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

// Initialize clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP_PHONE = process.env.TWILIO_PHONE_NUMBER;

// The 6-step text message cadence (2x a day for 3 days)
const DRIP_MESSAGES = {
  1: "Hey {name}, just wanted to make sure you got my first text about the tint special? Let me know what vehicle you have!",
  2: "Hey {name}, we have a couple bay spots opening up tomorrow. Did you still want to get a quote for your car?",
  3: "Good morning {name}! Just following up on your tint inquiry. We can upgrade you to ceramic if you're looking for heat rejection. What year is your car?",
  4: "Hey {name}, just checking in one more time today. Our $199 carbon special is filling up the schedule fast. Want me to save you a spot?",
  5: "Hi {name}. I don't want to bug you, just want to make sure we get you taken care of if you still need tint!",
  6: "Hey {name}, I'll close out your quote request for now. If you ever need tint, PPF, or glass work in the future, just save this number and text us!"
};

// Schedule the worker to run at 9:00 AM and 4:00 PM every day
cron.schedule('0 9,16 * * *', async () => {
  console.log('Running automated outbound follow-up queue...');

  try {
    // 1. Fetch all leads currently in the automated sequence
    const { data: leads } = await supabase
      .from('leads')
      .select('id, phone, name, drip_step')
      .eq('drip_active', true)
      .eq('status', 'Nurture Active')
      .lte('drip_step', 6); // Only process up to step 6

    if (!leads || leads.length === 0) return;

    // 2. Loop through active leads and send their specific next message
    for (const lead of leads) {
      // Personalize the message
      const rawMessage = DRIP_MESSAGES[lead.drip_step];
      const personalizedMessage = rawMessage.replace('{name}', lead.name.split(' ')[0]);

      // 3. Send via Twilio
      await twilioClient.messages.create({
        body: personalizedMessage,
        from: SHOP_PHONE,
        to: lead.phone
      });

      // 4. Log the outbound message to the database (so it shows in the React Inbox)
      await supabase.from('messages').insert({
        lead_id: lead.id,
        direction: 'outbound',
        body: personalizedMessage,
        timestamp: new Date()
      });

      // 5. Increment the drip step, or end the sequence if they hit message 6
      const nextStep = lead.drip_step + 1;
      const isActive = nextStep <= 6; 

      await supabase.from('leads')
        .update({ 
          drip_step: nextStep,
          drip_active: isActive,
          // If the drip is over, update their Kanban status
          ...( !isActive && { status: 'Cold / Unresponsive' } ) 
        })
        .eq('id', lead.id);
    }

    console.log(`Successfully processed ${leads.length} automated follow-ups.`);

  } catch (error) {
    console.error('Error processing outbound queue:', error);
  }
});

