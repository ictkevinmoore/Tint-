/**
 * Auto Styling & Tint Shop CRM - Node.js Database Schema & API Webhooks
 * Built for PostgreSQL (pg / Knex) and Express.js + Twilio Integration
 */

const express = require('express');
const router = express.Router();
const twilio = require('twilio');

// Initialize Twilio Client (Environment variables)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

/* ==========================================================================
   1. DATABASE SCHEMA DEFINITION (SQL DDL / Knex Migration Reference)
   ========================================================================== */

const SQL_SCHEMA_DDL = `
-- Customers / Vehicle Owners
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(150),
  vehicle_year INT,
  vehicle_make VARCHAR(50),
  vehicle_model VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Work Orders / Tint Jobs
CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
  status VARCHAR(30) DEFAULT 'SCHEDULED', -- INTAKE, IN_BAY, COMPLETED, CANCELLED
  film_package VARCHAR(50), -- Carbon, High-Performance Ceramic
  vlt_selection JSONB, -- { front_sides: "20%", rear_sides: "5%", back: "5%", windshield: "70%" }
  heat_demo_performed BOOLEAN DEFAULT FALSE,
  total_amount NUMERIC(10, 2) DEFAULT 0.00,
  promised_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Pre-Intake Inspections & Declined Upsells
CREATE TABLE intake_inspections (
  id SERIAL PRIMARY KEY,
  job_id INT REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
  pre_existing_damage JSONB, -- { scratches: true, rock_chips: "light pitting", windshield_crack: false }
  declined_ppf BOOLEAN DEFAULT FALSE,
  declined_ceramic BOOLEAN DEFAULT FALSE,
  declined_glass_repair BOOLEAN DEFAULT FALSE,
  estimated_declined_value NUMERIC(10, 2) DEFAULT 0.00,
  inspector_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Automated SMS Drip Subscriptions
CREATE TABLE sms_drip_subscriptions (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
  sequence_type VARCHAR(50) NOT NULL, -- LEAD_ACQUISITION, POST_INTAKE_RETARGET
  current_step INT DEFAULT 1,
  drip_active BOOLEAN DEFAULT TRUE,
  next_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Communication Logs
CREATE TABLE sms_logs (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL, -- INBOUND, OUTBOUND
  body TEXT NOT NULL,
  twilio_sid VARCHAR(100),
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_drips_active ON sms_drip_subscriptions(drip_active, next_run_at);
`;

/* ==========================================================================
   2. TEMPLATE DEFINITIONS FOR SMS DRIP SEQUENCES
   ========================================================================== */

const SEQUENCES = {
  LEAD_ACQUISITION: [
    { step: 1, delayMinutes: 0, body: (c) => `Hey ${c.first_name}, just saw you reached out about our $199 tint special! What vehicle do you drive?` },
    { step: 2, delayMinutes: 1440, body: (c) => `Hey ${c.first_name}, we have a couple bay spots opening up tomorrow. Did you still want to get a quote for your ${c.vehicle_model || 'vehicle'}?` },
    { step: 3, delayMinutes: 2880, body: (c) => `Good morning ${c.first_name}! Following up on your tint inquiry. We can also upgrade you to Ceramic if you're looking for heat rejection. What year is your car?` },
    { step: 4, delayMinutes: 3300, body: (c) => `Hey ${c.first_name}, checking in one more time today. Our $199 carbon special is filling up fast. Want me to save a spot for you?` },
    { step: 5, delayMinutes: 4320, body: (c) => `Hi ${c.first_name}, don't want to bug you! Just want to make sure we get you taken care of if you still need window tint.` },
    { step: 6, delayMinutes: 4740, body: (c) => `Hey ${c.first_name}, I'll close out your quote request for now. If you ever need tint, PPF, or glass work in the future, save this number and text us anytime!` }
  ],
  POST_INTAKE_RETARGET: [
    { step: 1, delayMinutes: 1440, body: (c) => `Hey ${c.first_name}, thanks for bringing your ${c.vehicle_model || 'car'} to the shop yesterday! Quick reminder: keep your windows rolled up for 3-5 days while the film cures. Let us know if you have questions!` },
    { step: 2, delayMinutes: 5760, body: (c) => `Hey ${c.first_name}, hope you're enjoying the cooler cabin! While inspecting your front bumper during intake, we noticed a few fresh stone marks starting. Here's how PPF stops highway rock chips: https://autostyling.com/ppf-demo. Want us to quote a front impact shield?` },
    { step: 3, delayMinutes: 14400, body: (c) => `Hey ${c.first_name}! As a returning tint client, we're holding a $100 voucher toward any Front Bumper PPF or Ceramic Coating for your ${c.vehicle_model || 'car'} if booked this month. Want us to reserve a bay spot?` }
  ]
};

/* ==========================================================================
   3. API WEBHOOK: TWILIO INBOUND SMS HANDLER (HALTS DRIP ON REPLY)
   ========================================================================== */

/**
 * Webhook triggered by Twilio when customer sends an inbound text message.
 * Safety Rule: Immediately sets drip_active = false to stop automated messages.
 */
router.post('/webhooks/twilio/inbound', async (req, res) => {
  const { From, Body, MessageSid } = req.body;
  const db = req.app.get('db'); // Knex or DB connection instance

  try {
    // 1. Normalize phone number format (+1XXXXXXXXXX)
    const normalizedPhone = From.trim();

    // 2. Lookup or create customer record
    let customer = await db('customers').where({ phone: normalizedPhone }).first();
    if (!customer) {
      const [newId] = await db('customers').insert({
        first_name: 'Valued',
        last_name: 'Customer',
        phone: normalizedPhone
      }).returning('id');
      customer = await db('customers').where({ id: newId }).first();
    }

    // 3. Log inbound SMS message
    await db('sms_logs').insert({
      customer_id: customer.id,
      direction: 'INBOUND',
      body: Body,
      twilio_sid: MessageSid
    });

    // 4. CRITICAL SAFETY RULE: Deactivate all active drip sequences for this customer
    const updatedRows = await db('sms_drip_subscriptions')
      .where({ customer_id: customer.id, drip_active: true })
      .update({ drip_active: false });

    console.log(`[SMS Webhook] Received reply from ${normalizedPhone}. Paused ${updatedRows} active drip(s).`);

    // 5. Notify front-desk staff / Unified Inbox socket
    req.app.get('io')?.emit('new_inbound_sms', {
      customerId: customer.id,
      phone: normalizedPhone,
      body: Body
    });

    // Respond to Twilio with empty TwiML
    const twiml = new twilio.twiml.MessagingResponse();
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('[SMS Webhook Error]:', error);
    res.status(500).send('Webhook Handler Error');
  }
});

/* ==========================================================================
   4. API WEBHOOK: INTAKE COMPLETED (TRIGGERS RE-TARGETING DRIP)
   ========================================================================== */

/**
 * Webhook triggered by tablet app when pre-tint vehicle intake checklist is saved.
 */
router.post('/webhooks/jobs/intake-completed', async (req, res) => {
  const { jobId, customerId, declinedPpf, declinedCeramic, declinedGlassRepair } = req.body;
  const db = req.app.get('db');

  try {
    // Update inspection record
    await db('intake_inspections').insert({
      job_id: jobId,
      customer_id: customerId,
      declined_ppf: declinedPpf || false,
      declined_ceramic: declinedCeramic || false,
      declined_glass_repair: declinedGlassRepair || false
    });

    // If customer declined PPF or Ceramic Coating, enroll in Post-Intake Re-Targeting Drip
    if (declinedPpf || declinedCeramic) {
      const firstStepDelayMs = SEQUENCES.POST_INTAKE_RETARGET[0].delayMinutes * 60 * 1000;
      const nextRunAt = new Date(Date.now() + firstStepDelayMs);

      await db('sms_drip_subscriptions').insert({
        customer_id: customerId,
        sequence_type: 'POST_INTAKE_RETARGET',
        current_step: 1,
        drip_active: true,
        next_run_at: nextRunAt
      });

      console.log(`[Intake Webhook] Customer #${customerId} declined upsells. Enrolled in POST_INTAKE_RETARGET drip.`);
    }

    res.status(200).json({ success: true, message: 'Intake processed and retargeting evaluated.' });
  } catch (error) {
    console.error('[Intake Webhook Error]:', error);
    res.status(500).json({ error: 'Failed to process intake submission' });
  }
});

/* ==========================================================================
   5. CRON WORKER ROUTINE: PROCESS SCHEDULED DRIP MESSAGES
   ========================================================================== */

/**
 * Called by cron job every 5 minutes (e.g. via node-cron or cloud scheduler).
 */
async function processPendingDrips(db) {
  const now = new Date();

  // Find all active subscriptions due for execution
  const dueDrips = await db('sms_drip_subscriptions')
    .join('customers', 'sms_drip_subscriptions.customer_id', 'customers.id')
    .select(
      'sms_drip_subscriptions.*',
      'customers.first_name',
      'customers.last_name',
      'customers.phone',
      'customers.vehicle_model'
    )
    .where('drip_active', true)
    .where('next_run_at', '<=', now);

  for (const drip of dueDrips) {
    const sequenceConfig = SEQUENCES[drip.sequence_type];
    if (!sequenceConfig) continue;

    const currentStepConfig = sequenceConfig.find(s => s.step === drip.current_step);
    if (!currentStepConfig) {
      // Sequence completed
      await db('sms_drip_subscriptions').where({ id: drip.id }).update({ drip_active: false });
      continue;
    }

    // Build personalized body text
    const messageBody = currentStepConfig.body(drip);

    try {
      // Dispatch via Twilio API
      const twilioRes = await twilioClient.messages.create({
        to: drip.phone,
        from: TWILIO_PHONE_NUMBER,
        body: messageBody
      });

      // Log outbound SMS
      await db('sms_logs').insert({
        customer_id: drip.customer_id,
        direction: 'OUTBOUND',
        body: messageBody,
        twilio_sid: twilioRes.sid
      });

      // Advance to next step or complete sequence
      const nextStepNum = drip.current_step + 1;
      const nextStepConfig = sequenceConfig.find(s => s.step === nextStepNum);

      if (nextStepConfig) {
        const delayDeltaMinutes = nextStepConfig.delayMinutes - currentStepConfig.delayMinutes;
        const nextRunAt = new Date(Date.now() + delayDeltaMinutes * 60 * 1000);

        await db('sms_drip_subscriptions').where({ id: drip.id }).update({
          current_step: nextStepNum,
          last_sent_at: now,
          next_run_at: nextRunAt
        });
      } else {
        // Final step finished
        await db('sms_drip_subscriptions').where({ id: drip.id }).update({
          drip_active: false,
          last_sent_at: now
        });
      }

      console.log(`[Drip Processor] Sent Step ${drip.current_step} (${drip.sequence_type}) to ${drip.phone}`);
    } catch (err) {
      console.error(`[Drip Processor Error] Failed to send SMS to ${drip.phone}:`, err);
    }
  }
}

module.exports = { router, processPendingDrips, SQL_SCHEMA_DDL };
