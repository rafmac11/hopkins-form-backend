// ============================================================
// Hopkins Concrete Contractors — Form Backend
// Receives form submissions, sends email via Resend,
// and pushes leads to CRM webhook.
// Deploy on Railway. Set env vars in Railway dashboard.
// ============================================================

const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------- ENV VARS (set these in Railway) ---------------
// RESEND_API_KEY        — your Resend API key
// RESEND_FROM_EMAIL     — verified sender, e.g. "Hopkins Concrete <noreply@webleadsnow.com>"
// NOTIFICATION_EMAIL    — where quote requests are sent
// CRM_WEBHOOK_URL       — your CRM inbound webhook endpoint
// CRM_API_KEY           — your CRM API key (sent as X-API-Key header)
// CRM_FORM_ID           — the form UUID your CRM expects
// ---------------------------------------------------------------

const resend = new Resend(process.env.RESEND_API_KEY);

// --- CORS (open — form is embedded across multiple client domains) ---
app.use(cors());

app.use(express.json());
app.use(express.static("public"));

// --- Health check ---
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "hopkins-concrete-form-backend" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ===============================================================
// POST /api/quote  —  Main form submission endpoint
// ===============================================================
app.post("/api/quote", async (req, res) => {
  try {
    const { name, phone, email, service, address, zipcode, timeline, budget, message } = req.body;

    // --- Basic validation ---
    const errors = [];
    if (!name || name.trim().length < 2) errors.push("name is required");
    if (!phone || phone.replace(/\D/g, "").length < 10) errors.push("valid phone is required");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("valid email is required");
    if (!service) errors.push("service is required");

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const timestamp = new Date().toISOString();

    // --- 1. Send notification email via Resend ---
    const emailResult = await sendNotificationEmail({
      name, phone, email, service, address, zipcode, timeline, budget, message, timestamp,
    });

    // --- 2. Push lead to CRM webhook ---
    const crmResult = await pushToCRM({
      name, phone, email, service, address, zipcode, timeline, budget, message, timestamp,
    });

    // --- 3. Send confirmation email to customer ---
    const confirmResult = await sendConfirmationEmail({ name, email, service });

    console.log(`[${timestamp}] New quote request from ${name} (${email}) — service: ${service}`);

    return res.json({
      success: true,
      message: "Quote request submitted successfully",
      details: {
        email_sent: emailResult.success,
        crm_pushed: crmResult.success,
        confirmation_sent: confirmResult.success,
      },
    });
  } catch (err) {
    console.error("Error processing quote request:", err);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again or call us directly.",
    });
  }
});

// ===============================================================
// Resend — Send notification email to business owner
// ===============================================================
async function sendNotificationEmail(data) {
  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || "Hopkins Concrete <noreply@webleadsnow.com>";
    const toEmail = process.env.NOTIFICATION_EMAIL || "info@hopkinsconcretecontractors.com";

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #03662b; padding: 20px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0;">New Quote Request</h1>
          <p style="color: #c8e6c9; margin: 5px 0 0;">Hopkins Concrete Contractors</p>
        </div>

        <div style="padding: 24px; background-color: #f9f9f9;">
          <h2 style="color: #03662b; border-bottom: 2px solid #03662b; padding-bottom: 8px;">Contact Info</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; font-weight: bold; width: 120px;">Name:</td><td>${data.name}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Phone:</td><td><a href="tel:${data.phone}">${data.phone}</a></td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Email:</td><td><a href="mailto:${data.email}">${data.email}</a></td></tr>
          </table>

          <h2 style="color: #03662b; border-bottom: 2px solid #03662b; padding-bottom: 8px; margin-top: 24px;">Project Details</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; font-weight: bold; width: 120px;">Service:</td><td>${data.service}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Address:</td><td>${data.address || "Not provided"}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Zip Code:</td><td>${data.zipcode || "Not provided"}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Timeline:</td><td>${data.timeline || "Not specified"}</td></tr>
            <tr><td style="padding: 8px 0; font-weight: bold;">Budget:</td><td>${data.budget || "Not specified"}</td></tr>
          </table>

          <h2 style="color: #03662b; border-bottom: 2px solid #03662b; padding-bottom: 8px; margin-top: 24px;">Message</h2>
          <p style="background: #fff; padding: 16px; border-radius: 6px; border: 1px solid #ddd;">${data.message || "No message provided"}</p>

          <p style="color: #888; font-size: 12px; margin-top: 24px;">Submitted at ${data.timestamp}</p>
        </div>
      </div>
    `;

    const result = await resend.emails.send({
      from: fromEmail,
      to: [toEmail],
      subject: `🏗️ New Quote Request — ${data.service} — ${data.name}`,
      html,
    });

    console.log("Notification email sent:", result);
    return { success: true, id: result.data?.id };
  } catch (err) {
    console.error("Failed to send notification email:", err);
    return { success: false, error: err.message };
  }
}

// ===============================================================
// Resend — Send confirmation email to the customer
// ===============================================================
async function sendConfirmationEmail({ name, email, service }) {
  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL || "Hopkins Concrete <noreply@webleadsnow.com>";

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #03662b; padding: 20px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0;">Thank You, ${name}!</h1>
        </div>
        <div style="padding: 24px;">
          <p>We received your request for <strong>${service}</strong> and our team will be in touch within 24 hours with a free estimate.</p>
          <p>If you need immediate help, call us at <a href="tel:6124733196" style="color: #03662b; font-weight: bold;">612-473-3196</a>.</p>
          <p style="margin-top: 24px;">— The Hopkins Concrete Team</p>
        </div>
      </div>
    `;

    const result = await resend.emails.send({
      from: fromEmail,
      to: [email],
      subject: `We received your quote request — Hopkins Concrete`,
      html,
    });

    console.log("Confirmation email sent to customer:", result);
    return { success: true, id: result.data?.id };
  } catch (err) {
    console.error("Failed to send confirmation email:", err);
    return { success: false, error: err.message };
  }
}

// ===============================================================
// CRM — Push lead via webhook (flat payload + X-API-Key auth)
// ===============================================================
async function pushToCRM(data) {
  const webhookUrl = process.env.CRM_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("CRM_WEBHOOK_URL not set — skipping CRM push");
    return { success: false, error: "CRM_WEBHOOK_URL not configured" };
  }

  try {
    const payload = {
      form_id: process.env.CRM_FORM_ID || "hopkins-concrete-quote",
      source: "website",
      name: data.name,
      email: data.email,
      phone: data.phone,
      zip_code: data.zipcode || "",
      service: data.service,
      address: data.address || "",
      timeline: data.timeline || "",
      budget: data.budget || "",
      message: data.message || "",
      submitted_at: data.timestamp,
      source_url: "https://hopkinsconcretecontractors.com/contact-2/",
    };

    const headers = {
      "Content-Type": "application/json",
    };

    // Add API key if set
    if (process.env.CRM_API_KEY) {
      headers["X-API-Key"] = process.env.CRM_API_KEY;
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    console.log(`CRM webhook response (${response.status}):`, responseText);

    return { success: response.ok, status: response.status };
  } catch (err) {
    console.error("Failed to push to CRM:", err);
    return { success: false, error: err.message };
  }
}

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ Hopkins Concrete form backend running on port ${PORT}`);
  console.log(`   Resend API key: ${process.env.RESEND_API_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`   CRM webhook:    ${process.env.CRM_WEBHOOK_URL ? "✓ set" : "✗ MISSING"}`);
  console.log(`   CRM API key:    ${process.env.CRM_API_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`   Notification:   ${process.env.NOTIFICATION_EMAIL || "(default)"}`);
});
