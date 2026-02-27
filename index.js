const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { z } = require("zod");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require('nodemailer');
const crypto = require("crypto");

// ✅ DOCX generation
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const ImageModule = require("docxtemplater-image-module-free");
const { imageSize } = require("image-size");

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// ================== ENV ==================
dotenv.config();

// ================== CONFIG ==================
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const ALLOWED_ORIGINS = ["https://avocarbon-llc.azurewebsites.net", "http://localhost:3000", "http://localhost:3002"];
const RESET_TOKEN_TTL_HOURS = Number(process.env.RESET_TOKEN_TTL_HOURS || 1);

// ================== APP ==================
const app = express();

// ✅ JSON body parser (needed for auth)
app.use(express.json({ limit: "2mb" }));

// ================== CORS MANUEL ==================
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // ✅ si origin existe et est dans la liste -> autoriser
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  // ✅ important pour caching / preflight
  res.header("Vary", "Origin");

  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// =========================
// CONFIGURATION FIXE POUR OUTLOOK
// =========================
const SMTP_HOST = "avocarbon-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration STS";
const EMAIL_FROM = "administration.STS@avocarbon.com";

console.log('📧 Configuration SMTP Outlook:', {
  host: SMTP_HOST,
  port: SMTP_PORT,
  from: EMAIL_FROM,
  fromName: EMAIL_FROM_NAME
});

// Configuration du transporteur email
const emailTransporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { 
    ciphers: 'SSLv3',
    rejectUnauthorized: false 
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  debug: process.env.NODE_ENV === 'development'
});

async function convertDocxToPdf({
  inputDocxAbsPath,
  outputDirAbs,
  sofficePath,
}) {
  if (!inputDocxAbsPath || !fs.existsSync(inputDocxAbsPath)) {
    throw new Error(`Input DOCX not found: ${inputDocxAbsPath}`);
  }

  if (!outputDirAbs || !fs.existsSync(outputDirAbs)) {
    throw new Error(`Output directory not found: ${outputDirAbs}`);
  }

  // Détection automatique de LibreOffice sous Windows
  let soffice = sofficePath;
  if (!soffice) {
    const candidates = [
      "C:\\\\Program Files\\\\LibreOffice\\\\program\\\\soffice.exe",
      "C:\\\\Program Files (x86)\\\\LibreOffice\\\\program\\\\soffice.exe",
      "soffice", // fallback si dans le PATH
    ];

    soffice = candidates.find((p) => {
      try {
        return p === "soffice" || fs.existsSync(p);
      } catch {
        return false;
      }
    });

    if (!soffice) {
      throw new Error("LibreOffice (soffice.exe) not found on this system");
    }
  }

  // Conversion DOCX → PDF
  await execFileAsync(soffice, [
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    "--nodefault",
    "--norestore",
    "--convert-to",
    "pdf",
    "--outdir",
    outputDirAbs,
    inputDocxAbsPath,
  ]);

  const base = path.basename(
    inputDocxAbsPath,
    path.extname(inputDocxAbsPath)
  );
  const pdfAbs = path.join(outputDirAbs, `${base}.pdf`);

  if (!fs.existsSync(pdfAbs)) {
    throw new Error(
      `PDF conversion failed: expected file not found (${pdfAbs})`
    );
  }

  return pdfAbs;
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildResetLink({ token, email }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://avocarbon-llc.azurewebsites.net";
  const base = FRONTEND_URL.replace(/\/$/, "");
  const query = `token=${encodeURIComponent(token)}${email ? `&email=${encodeURIComponent(email)}` : ""}`;
  return `${base}/reset-password?${query}`;
}

async function sendResetPasswordMail({ to, resetLink }) {
  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>Password reset</h2>

      <p>We received a request to reset your password.</p>

      <p style="margin:24px 0">
        <a href="${resetLink}"
           style="
             background:#0e4e78;
             color:#ffffff;
             padding:12px 20px;
             border-radius:10px;
             text-decoration:none;
             font-weight:600;
             display:inline-block;
           ">
          Reset your password
        </a>
      </p>

      <p style="font-size:12px;color:#6b7280">
        If you did not request this, you can ignore this email.
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: "Password reset request",
    html,
  });

  console.log(`Password reset email sent to ${to}`);
}

function generatePmToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendPmReviewMail({ to, llcId, token }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://avocarbon-llc.azurewebsites.net";
  const reviewLink = `${FRONTEND_URL}/pm-review/${llcId}?token=${encodeURIComponent(token)}`;

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>LLC #${llcId} – Approval required</h2>

      <p>
        A <b>Lesson Learned (LLC)</b> has been submitted and requires your approval.
      </p>

      <p>
        👉 Click the link below to review the LLC and approve or reject it:
      </p>

      <p style="margin:24px 0">
        <a href="${reviewLink}"
           style="
             background:#0e4e78;
             color:#ffffff;
             padding:12px 20px;
             border-radius:10px;
             text-decoration:none;
             font-weight:600;
             display:inline-block;
           ">
          Open the LLC for approval
        </a>
      </p>

      <p style="font-size:12px;color:#6b7280">
        This link is personal and temporary.<br/>
        If you are not the correct approver, please ignore this message.
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `LLC #${llcId} – PM approval required`,
    html
  });

  console.log(`📨 PM approval email sent to ${to} for LLC #${llcId}`);
}

function generateFinalToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function getLlcEditorAndValidator(llcId) {
  const r = await pool.query(
    `SELECT editor, validator, plant FROM public.llc WHERE id=$1`,
    [llcId]
  );
  if (!r.rowCount) return { editor: "", validator: "", plant: "" };
  return {
    editor: r.rows[0].editor || "",
    validator: r.rows[0].validator || "",
    plant: r.rows[0].plant || "",
  };
}

async function sendFinalReviewMail({ to, llcId, token }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://avocarbon-llc.azurewebsites.net";
  const reviewLink = `${FRONTEND_URL}/final-review/${llcId}?token=${encodeURIComponent(token)}`;

  const { editor, validator, plant } = await getLlcEditorAndValidator(llcId);

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>LLC #${llcId} – Final approval required</h2>

      <p>
        <b>Plant:</b> <b>${plant || "N/A"}</b><br/><br/>

        This LLC has been <b>edited by</b> <b>${editor || "the Quality team"}</b><br/>
        and <b>validated by</b> <b>${validator || "the Plant Manager"}</b>.<br/>
        It now requires your <b>final approval</b>.
      </p>

      <p>👉 Click the link below to review the LLC and approve or reject it:</p>

      <p style="margin:24px 0">
        <a href="${reviewLink}"
           style="
             background:#0e4e78;
             color:#ffffff;
             padding:12px 20px;
             border-radius:10px;
             text-decoration:none;
             font-weight:600;
             display:inline-block;
           ">
          Open the LLC for final approval
        </a>
      </p>

      <p style="font-size:12px;color:#6b7280">
        This link is personal and temporary.<br/>
        If you are not the correct approver, please ignore this message.
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `LLC #${llcId} – Final approval required`,
    html,
  });

  console.log(`📨 FINAL approval email sent to ${to} for LLC #${llcId}`);
}

async function sendPmDecisionResultMail({ to, llcId, decision, reason }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://avocarbon-llc.azurewebsites.net";
  const viewLink = `${FRONTEND_URL}/qualityLessonLearned`;
  const editLink = `${FRONTEND_URL}/llc/${llcId}/edit`;

  const isRejected = decision === "REJECTED";

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>LLC #${llcId} – PM approval result</h2>

      <p>
        PM decision: <b style="color:${isRejected ? "#b91c1c" : "#047857"}">${decision}</b>
      </p>

      ${
        isRejected
          ? `<p><b>Reason:</b><br/>${String(reason || "").replaceAll("\n", "<br/>")}</p>
             <p style="margin:24px 0">
               <a href="${editLink}"
                  style="background:#ef7807;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
                 Edit the LLC
               </a>
             </p>`
          : `<p>The LLC has moved to the <b>Final Approval</b> step.</p>
             <p style="margin:24px 0">
               <a href="${viewLink}"
                  style="background:#0e4e78;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
                 Open the dashboard
               </a>
             </p>`
      }
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `LLC #${llcId} – PM decision: ${decision}`,
    html,
  });
}

async function sendFinalDecisionResultMail({ to, llcId, decision, reason, generated_llc }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://avocarbon-llc.azurewebsites.net";
  const editLink = `${FRONTEND_URL}/llc/${llcId}/edit`;

  const docxLink = generated_llc ? `${FRONTEND_URL}/${generated_llc}` : "";
  const isRejected = decision === "REJECTED";

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>LLC #${llcId} – Final approval result</h2>

      <p>
        Final decision: <b style="color:${isRejected ? "#b91c1c" : "#047857"}">${decision}</b>
      </p>

      ${
        isRejected
          ? `<p><b>Reason:</b><br/>${String(reason || "").replaceAll("\n", "<br/>")}</p>
             <p style="margin:24px 0">
               <a href="${editLink}"
                  style="background:#ef7807;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
                 Edit the LLC
               </a>
             </p>`
          : `<p>The LLC has been <b>fully approved</b>.</p>
             ${
               docxLink
                 ? `<p style="margin:24px 0">
                      <a href="${docxLink}"
                         style="background:#0e4e78;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
                        Download the PDF
                      </a>
                    </p>`
                 : ""
             }`
      }
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `LLC #${llcId} – Final decision: ${decision}`,
    html,
  });
}

async function getLlcEditorEmail(llcId) {
  const r = await pool.query(`SELECT editor, generated_llc FROM public.llc WHERE id=$1`, [llcId]);
  if (!r.rowCount) return { editorEmail: "", generated_llc: "" };
  return { editorEmail: r.rows[0].editor || "", generated_llc: r.rows[0].generated_llc || "" };
}

async function getDistributionRecipientsEmails({ plantKeys }) {
  if (!plantKeys?.length) return [];

  // map key => "FRANKFURT Plant"
  const plants = plantKeys.map(k => `${k} Plant`);

  const r = await pool.query(
    `
    SELECT DISTINCT email
    FROM public.users
    WHERE plant = ANY($1::text[])
      AND role IN ('plant_manager','quality_manager')
    `,
    [plants]
  );

  return r.rows.map(x => x.email).filter(Boolean);
}

async function sendDistributionMail({
  toList,
  llcId,
  productLineLabel,
  creatorPlant,
  generated_llc,            // ✅ ex: "uploads/generated/LLC_12_xxx.pdf"
}) {
  if (!toList?.length) {
    console.log("ℹ️ No distribution recipients for LLC", llcId);
    return;
  }

  const FORM_LINK = "https://evidence-deployment.azurewebsites.net/evidenceDeployment";

  // lien vers le PDF (si dispo)
  const API_BASE_URL = process.env.API_BASE_URL || `https://llc-back.azurewebsites.net`;
  const fileLink = generated_llc ? `${API_BASE_URL}/${generated_llc}` : "";

  // (Optionnel) nom de fichier propre
  const fileLabel = generated_llc ? path.basename(generated_llc) : "N/A";

  // ⚠️ Ton texte exact (avec retour à la ligne + bullet)
  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6; font-size:14px; color:#111827">
      <p>Hello,</p>
      <p>
        you have a new LLC Card from <b>${String(productLineLabel || "")}</b> , 
        <b>${String(creatorPlant || "")}</b> PLANT to transversalize in your plant :
        <br/>
        ${
          fileLink
            ? `<a href="${fileLink}">${fileLabel}</a>`
            : `<span>${fileLabel}</span>`
        }
      </p>

      <p><b>PLEASE NOTE:</b> The LLC deployment period is 30 days from the date of receipt</p>

      <p>
        to start please reply via this form to specify if your Plant :
        <br/>
        - Non concerned / Implemented befor LL / Concerned
      </p>

      <p style="margin:18px 0">
        <a href="${FORM_LINK}"
           style="background:#0e4e78;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
          Open Evidence Deployment Form
        </a>
      </p>
    </div>
  `;

  // ✅ Optionnel : joindre le PDF en pièce jointe
  // (Ça marche si le fichier existe physiquement sur ce serveur)
  const attachments = [];
  if (generated_llc) {
    const abs = path.join(process.cwd(), generated_llc);
    if (fs.existsSync(abs)) {
      attachments.push({
        filename: path.basename(abs),
        path: abs,
      });
    }
  }

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to: toList.join(","),
    subject: `LLC #${llcId} – Distribution`,
    html,
    attachments, // ✅ enlève cette ligne si tu ne veux PAS de pièce jointe
  });

  console.log(`📨 Distribution mail sent for LLC #${llcId} to:`, toList);
}

async function sendDistributionInfoToAdminMail({
  to,
  llcId,
  productLineLabel,
  creatorPlant,
  distributedPlants,   
  generated_llc,
}) {
  if (!to) {
    console.error("❌ No admin email. Distribution info not sent.");
    return;
  }

  const API_BASE_URL = process.env.API_BASE_URL || `https://llc-back.azurewebsites.net`;
  const fileLink = generated_llc ? `${API_BASE_URL}/${generated_llc}` : "";
  const fileLabel = generated_llc ? path.basename(generated_llc) : "N/A";

  const plantsHtml = (distributedPlants || [])
    .map(p => `<li>${String(p)}</li>`)
    .join("");

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6; font-size:14px; color:#111827">
      <h2>LLC #${llcId} – Distributed to plants</h2>

      <p>
        <b>Product line:</b> ${String(productLineLabel || "N/A")}<br/>
        <b>Creator plant:</b> ${String(creatorPlant || "N/A")}
      </p>

      <p>
        The LLC has been distributed to the following plants:
      </p>

      <ul>
        ${plantsHtml || "<li>(none)</li>"}
      </ul>

      <p>
        ${
          fileLink
            ? `PDF: <a href="${fileLink}">${fileLabel}</a>`
            : `PDF: ${fileLabel}`
        }
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `LLC #${llcId} – Distributed to ${distributedPlants?.length || 0} plant(s)`,
    html,
  });

  console.log(`📨 Admin distribution info email sent to ${to} for LLC #${llcId}`);
}

async function getLlcAttachments(client, llcId) {
  const r = await client.query(
    `SELECT id, scope, filename, storage_path
     FROM public.llc_attachment
     WHERE llc_id = $1
     ORDER BY id ASC`,
    [llcId]
  );
  return r.rows || [];
}

async function getRootCausesWithAttachments(client, llcId) {
  const rcRes = await client.query(
    `SELECT *
     FROM public.llc_root_cause
     WHERE llc_id = $1
     ORDER BY id ASC`,
    [llcId]
  );

  const rc = rcRes.rows || [];
  const ids = rc.map((x) => x.id);

  let att = [];
  if (ids.length) {
    const attRes = await client.query(
      `SELECT id, root_cause_id, filename, storage_path
       FROM public.llc_root_cause_attachment
       WHERE root_cause_id = ANY($1::int[])
       ORDER BY id ASC`,
      [ids]
    );
    att = attRes.rows || [];
  }

  const byRc = att.reduce((acc, a) => {
    (acc[a.root_cause_id] ||= []).push(a);
    return acc;
  }, {});

  return rc.map((one) => ({ ...one, attachments: byRc[one.id] || [] }));
}

async function getProcessingAttachments(client, processingId) {
  const r = await client.query(
    `SELECT scope, filename, storage_path
     FROM public.llc_deployment_processing_attachment
     WHERE processing_id=$1
     ORDER BY id ASC`,
    [processingId]
  );
  return r.rows || [];
}

function pickFirstProcessingAbs(attachments, scope) {
  const a = (attachments || []).find(x => x.scope === scope);
  return a ? path.join(process.cwd(), a.storage_path) : "";
}

async function generateDeploymentPdfForProcessing({
  client,
  llcRow,
  processingRow,
}) {
  const templatePath =
    processingRow.deployment_applicability === "Not concerned"
      ? TEMPLATE_DEP_NC_PATH
      : TEMPLATE_DEP_PATH;

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Deployment template not found: ${templatePath}`);
  }

    // ✅ distribution_to recalculé comme /api/llc
  const dist = buildDistributionExcludingPlant({
    productLineLabel: llcRow.product_line_label,
    creatorPlant: llcRow.plant,
  });
  const distribution_to = dist.filteredText;

  // ✅ 1) Load processing attachments (before/after dep + evidence files)
  const procAtt = await getProcessingAttachments(client, processingRow.id);

  // ✅ 2) Load LLC attachments (situation_before/after + bad/good)
  const llcAtt = await getLlcAttachments(client, llcRow.id);

  // ✅ 3) Load root causes + their attachments (evidence image)
  const rootCausesDb = await getRootCausesWithAttachments(client, llcRow.id);

  // ---------- helpers ----------
  const pickFirstLlcScopeAbs = (attachments, scope) => {
    const a = (attachments || []).find((x) => x.scope === scope);
    if (!a) return "";
    return path.join(process.cwd(), a.storage_path); // ✅ ABS for ImageModule
  };

  const isImageFilename = (filename = "") =>
    /\.(png|jpe?g|gif|bmp|webp)$/i.test(filename);

  const buildEvidenceFromDb = (rc) => {
    // take first attachment of this root cause (if any)
    const a = (rc.attachments || [])[0];
    if (!a) return { evidence_image: "", evidence_link: "", evidence_name: "" };

    const abs = path.join(process.cwd(), a.storage_path);
    const img = isImageFilename(a.filename);

    return {
      evidence_image: img ? abs : "",     // ✅ for docxtemplater image module
      evidence_link: img ? "" : a.storage_path,
      evidence_name: a.filename,
    };
  };

  // ✅ Build rootCauses array exactly like template expects
  const rootCauses = (rootCausesDb || []).map((rc, i) => ({
    index: i + 1,
    root_cause: rc.root_cause,
    detailed_cause_description: rc.detailed_cause_description,
    solution_description: rc.solution_description,
    conclusion: rc.conclusion,
    process: rc.process,
    origin: rc.origin,
    ...buildEvidenceFromDb(rc),
  }));

  const docData = {
    // =========================
    // champs LLC (source vérité)
    // =========================
    id: llcRow.id,
    problem_short: llcRow.problem_short,
    created_at: formatDateDMY(llcRow.created_at),
    editor: llcRow.editor,
    final_validation_date: llcRow.final_validation_date
      ? formatDateDMY(llcRow.final_validation_date)
      : "",
    validator: llcRow.validator,

    product_line_label: llcRow.product_line_label,
    application_label: llcRow.application_label,
    customer: llcRow.customer,
    product_family: llcRow.product_family,
    plant: llcRow.plant,
    part_or_machine_number: llcRow.part_or_machine_number,
    quality_detection: llcRow.quality_detection,
    product_type: llcRow.product_type,
    problem_detail: llcRow.problem_detail,
    conclusions: llcRow.conclusions,
    distribution_to: distribution_to,

    // =========================
    // ✅ images LLC attendues par template
    // =========================
    situation_before: pickFirstLlcScopeAbs(llcAtt, "SITUATION_BEFORE"),
    situation_after: pickFirstLlcScopeAbs(llcAtt, "SITUATION_AFTER"),
    bad_part: pickFirstLlcScopeAbs(llcAtt, "BAD_PART"),
    good_part: pickFirstLlcScopeAbs(llcAtt, "GOOD_PART"),

    // =========================
    // ✅ root causes table attendue par template
    // =========================
    rootCauses,

    // (optionnel si tu as un placeholder texte dans le template)
    rootCauses_text: rootCauses
      .map(
        (rc, i) =>
          `${i + 1}. ${rc.root_cause}\n- ${rc.detailed_cause_description}\n- Solution: ${rc.solution_description}\n- Conclusion: ${rc.conclusion}\n- Process: ${rc.process}\n- Origin: ${rc.origin}`
      )
      .join("\n\n"),

    // =========================
    // ✅ champs processing
    // =========================
    person: processingRow.person,
    evidence_plant: processingRow.evidence_plant,
    deployment_description: processingRow.deployment_description,
    deployment_applicability: processingRow.deployment_applicability,
    why_not_apply: processingRow.why_not_apply || "",
    deployment_date: processingRow.deployment_date
      ? formatDateDMY(processingRow.deployment_date)
      : formatDateDMY(),

    // ✅ images processing
    before_dep: pickFirstProcessingAbs(procAtt, "BEFORE_DEP"),
    after_dep: pickFirstProcessingAbs(procAtt, "AFTER_DEP"),
  };

  // 1) DOCX buffer
  const buffer = generateDocxBuffer(templatePath, docData);

  // 2) write docx
  const baseName = `DEP_${llcRow.id}_${safeName(processingRow.evidence_plant)}_${Date.now()}`;
  const docxAbs = path.join(generatedDirAbs, `${baseName}.docx`);
  fs.writeFileSync(docxAbs, buffer);

  // 3) convert to PDF
  const pdfAbs = await convertDocxToPdf({
    inputDocxAbsPath: docxAbs,
    outputDirAbs: generatedDirAbs,
    sofficePath: process.env.SOFFICE_PATH,
  });

  try { fs.unlinkSync(docxAbs); } catch {}

  return relPath(pdfAbs);
}

function generateDepToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendDepReviewMail({ to, llcId, processingId, token, evidencePlant }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "https://avocarbon-llc.azurewebsites.net";
  const reviewLink = `${FRONTEND_URL}/dep-review/${processingId}?token=${encodeURIComponent(token)}`;

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>DEP LLC #${llcId} – Approval required</h2>

      <p>
        Evidence need your approval from plant: <b>${String(evidencePlant || "N/A")}</b>
      </p>

      <p style="margin:24px 0">
        <a href="${reviewLink}"
           style="background:#0e4e78;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
          Open DEP for approval
        </a>
      </p>

      <p style="font-size:12px;color:#6b7280">
        This link is personal and temporary.
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `Evidence need your approval from plant: ${evidencePlant || "N/A"}`,
    html,
  });

  console.log(`📨 DEP approval email sent to ${to} for processing #${processingId}`);
}

function generateDepReworkToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function getProcessingPersonEmail(processingId) {
  const r = await pool.query(`SELECT person FROM public.llc_deployment_processing WHERE id=$1`, [processingId]);
  return r.rowCount ? (r.rows[0].person || "") : "";
}

async function sendDepReworkMailToEditor({ to, llcId, processingId, token, reason, evidencePlant }) {
  const FRONT_FORM_URL = process.env.FRONTEND_DEP_FORM_URL || "https://evidence-deployment.azurewebsites.net";

  const link = `${FRONT_FORM_URL}?processingId=${encodeURIComponent(processingId)}&token=${encodeURIComponent(token)}`;

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>DEP LLC #${llcId} – Rework required</h2>

      <p>
        The Evidence Deployment from <b>${String(evidencePlant || "N/A")}</b> has been
        <b style="color:#b91c1c">REJECTED</b>.
      </p>

      ${
        reason
          ? `<p><b>Reason:</b><br/>${String(reason).replaceAll("\n", "<br/>")}</p>`
          : ""
      }

      <p style="margin:24px 0">
        <a href="${link}"
           style="background:#ef7807;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">
          Re-open Evidence Deployment (pre-filled)
        </a>
      </p>

      <p style="font-size:12px;color:#6b7280">
        This link is personal and temporary.
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `DEP LLC #${llcId} – Rework required (${evidencePlant || "N/A"})`,
    html,
  });

  console.log(`📨 DEP rework email sent to ${to} for processing #${processingId}`);
}

function publicFileUrl(storage_path) {
  // storage_path ressemble à "uploads/xxx..."
  const API_BASE_URL = process.env.API_BASE_URL || `https://llc-back.azurewebsites.net`;
  if (!storage_path) return "";
  return `${API_BASE_URL}/${storage_path.replace(/^\/+/, "")}`;
}

// =========================
// Configuration de la base
// =========================
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 5432),
  ssl: { require: true, rejectUnauthorized: false },
};

console.log("🔧 Configuration DB:", {
  user: dbConfig.user,
  host: dbConfig.host,
  database: dbConfig.database,
  port: dbConfig.port,
  ssl: "Activé",
  password: dbConfig.password ? "✅ Présent" : "❌ Manquant",
});

const pool = new Pool(dbConfig);

const SALT_ROUNDS = 10;
const UPSERT = false; // false = n'écrase pas si email existe, true = update si existe

const users = [
  { name: "Ons Ghariani", email: "ons.ghariani@avocarbon.com", plant: "ALL", role: "admin", password: "azertycvadmin" },

  { name: "Ons Ghariani", email: "ons.ghariani@avocarbon.com", plant: "TEST Plant", role: "quality_manager", password: "azertycv" },
  { name: "Ons Ghariani", email: "ons.ghariani@avocarbon.com", plant: "TEST Plant", role: "plant_manager", password: "azertycvplant" },

  { name: "Ons", email: "ons.ghariani@avocarbon.com", plant: "TEST02 Plant", role: "quality_manager", password: "ons123" },
  { name: "Ons", email: "ons.ghariani@avocarbon.com", plant: "TEST02 Plant", role: "plant_manager", password: "ons12345" },

  { name: "Gayathri N", email: "gayathri.n@avocarbon.com", plant: "CHENNAI Plant", role: "quality_manager", password: "Gayathri@2026!" },
  { name: "Sridhar B", email: "sridhar.b@avocarbon.com", plant: "CHENNAI Plant", role: "plant_manager", password: "Sridhar@2026!" },

  { name: "Weijiang Peng", email: "weijiang.peng@avocarbon.com", plant: "TIANJIN Plant", role: "quality_manager", password: "WeiJiang@2026!" },
  { name: "Yang Yang", email: "yang.yang@avocarbon.com", plant: "TIANJIN Plant", role: "plant_manager", password: "Yang@2026!" },

  { name: "Daniel Beil", email: "daniel.beil@avocarbon.com", plant: "FRANKFURT Plant", role: "quality_manager", password: "Daniel@2026!" },
  { name: "Dagmar Ansinn", email: "dagmar.ansinn@avocarbon.com", plant: "FRANKFURT Plant", role: "plant_manager", password: "Dagmar@2026!" },

  { name: "Louis Lu", email: "louis.lu@avocarbon.com", plant: "ANHUI Plant", role: "quality_manager", password: "Louis@2026!" },
  { name: "Jaeseok Lee", email: "jaeseok.lee@avocarbon.comon.com", plant: "ANHUI Plant", role: "quality_manager", password: "Jaeseok@2026!" },
  { name: "Samtak Joo", email: "samtak.joo@avocarbon.com", plant: "ANHUI Plant", role: "plant_manager", password: "Samtak@2026!" },

  { name: "Tim Zhao", email: "tim.zhao@avocarbon.com", plant: "KUNSHAN Plant", role: "quality_manager", password: "Tim@2026!" },
  { name: "Allan Riegel", email: "allan.riegel@avocarbon.com", plant: "KUNSHAN Plant", role: "plant_manager", password: "Allan@2026!" },

  { name: "Mohamed Naili", email: "mohamed.naili@avocarbon.com", plant: "SAME Plant", role: "quality_manager", password: "Mohamed@2026!" },
  { name: "Salah Benachour", email: "salah.benachour@avocarbon.com", plant: "SAME Plant", role: "plant_manager", password: "Salah@2026!" },

  { name: "Lassaad Charaabi", email: "lassaad.charaabi@avocarbon.com", plant: "SCEET Plant", role: "quality_manager", password: "Lassaad@2026!" },
  { name: "Imed Benalaya", email: "imed.benalaya@avocarbon.com", plant: "SCEET Plant", role: "plant_manager", password: "Imed@2026!" },

  { name: "Gabriel Fernandez", email: "gabriel.fernandez@avocarbon.com", plant: "MONTERREY Plant", role: "quality_manager", password: "Gabriel@2026!" },
  { name: "Hector Olivares", email: "hector.olivares@avocarbon.com", plant: "MONTERREY Plant", role: "plant_manager", password: "Hector@2026!" },

  { name: "Florence Paradis", email: "florence.paradis@avocarbon.com", plant: "CYCLAM Plant", role: "quality_manager", password: "FlorenceQ@2026!" },
  { name: "Florence Paradis", email: "florence.paradis@avocarbon.com", plant: "CYCLAM Plant", role: "plant_manager", password: "FlorenceP@2026!" },

  { name: "Jean-Francois Savarieau", email: "jean-francois.savarieau@avocarbon.com", plant: "POITIERS Plant", role: "quality_manager", password: "Jean@2026!" },
];

function validateUser(u) {
  if (!u?.name || !u?.email || !u?.plant || !u?.role || !u?.password) return false;
  if (!u.email.includes("@")) return false;
  if (u.password.length < 6) return false;
  return true;
}

async function main() {
  const client = await pool.connect();
  const created = [];
  const updated = [];
  const skipped = [];

  try {
    await client.query("BEGIN");

    for (const u of users) {
      if (!validateUser(u)) {
        throw new Error(`Invalid user entry: ${JSON.stringify(u)}`);
      }

      const email = u.email.toLowerCase().trim();
      const passwordHash = await bcrypt.hash(u.password, SALT_ROUNDS);

      if (!UPSERT) {
        const r = await client.query(
          `
          INSERT INTO users (name, email, plant, role, password_hash)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT ON CONSTRAINT users_email_plant_role_uniq DO NOTHING
          RETURNING email
          `,
          [u.name, email, u.plant, u.role, passwordHash]
        );

        if (r.rowCount === 1) created.push(email);
        else skipped.push(email);
      } else {
        const r = await client.query(
          `
          INSERT INTO users (name, email, plant, role, password_hash)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING email
          `,
          [u.name, email, u.plant, passwordHash]
        );

        if (r.rowCount === 1) updated.push(email);
      }
    }

    await client.query("COMMIT");

    console.log("✅ Bulk create done");
    console.log("Created:", created.length, created);
    console.log("Updated:", updated.length, updated);
    console.log("Skipped:", skipped.length, skipped);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Error:", e?.message || e);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}
main();

const PLANT_VALIDATOR = {
  "TEST Plant": "ons.ghariani@avocarbon.com",
  "TEST02 Plant": "ons.ghariani@avocarbon.com",
  "FRANKFURT Plant": "dagmar.ansinn@avocarbon.com",
  "KUNSHAN Plant": "allan.riegel@avocarbon.com",
  "MONTERREY Plant": "hector.olivares@avocarbon.com",
  "CHENNAI Plant": "sridhar.b@avocarbon.com",
  "SCEET Plant": "imed.benalaya@avocarbon.com",
  "ANHUI Plant": "samtak.joo@avocarbon.com",
  "CYCLAM Plant": "florence.paradis@avocarbon.com",
  "TIANJIN Plant": "yang.yang@avocarbon.com",
  "SAME Plant": "salah.benachour@avocarbon.com",
  "POITIERS Plant": "sebastien.charpentier@avocarbon.com",
};

function validatorForPlantExact(plant) {
  const v = PLANT_VALIDATOR[plant];
  if (!v) {
    throw new Error(`No validator configured for plant: "${plant}"`);
  }
  return v;
}

const DISTRIBUTION_BY_PRODUCT_LINE = {
  PRODUCT: "TEST - TEST02",
  BRUSH: "TEST - FRANKFURT - POITIERS - TIANJIN - CHENNAI",
  CHOKES: "SAME - SCEET - MONTERREY - ANHUI - KUNSHAN - CHENNAI",
  ASSEMBLY: "SAME - SCEET - MONTERREY - ANHUI - KUNSHAN - POITIERS",
  SEALS: "CYCLAM - CHENNAI - SAME - SCEET - MONTERREY",
  INJECTION: "SAME - SCEET - MONTERREY",
  ALL: "FRANKFURT - POITIERS - TIANJIN - CHENNAI - SAME - SCEET - MONTERREY - ANHUI - KUNSHAN - CYCLAM",
};

function distributionToForProductLine(label) {
  const key = String(label || "").trim().toUpperCase();
  return DISTRIBUTION_BY_PRODUCT_LINE[key] || "";
}

function splitDistributionKeys(distributionStr) {
  return String(distributionStr || "")
    .split("-")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

// exemple: "FRANKFURT Plant" -> "FRANKFURT"
function plantNameToKey(plantName) {
  return String(plantName || "")
    .replace(/\s*plant\s*$/i, "")
    .trim()
    .toUpperCase();
}

function buildDistributionExcludingPlant({ productLineLabel, creatorPlant }) {
  const raw = distributionToForProductLine(productLineLabel); // ex: "FRANKFURT - POITIERS - ..."
  const keys = splitDistributionKeys(raw);

  const creatorKey = plantNameToKey(creatorPlant);
  const filtered = keys.filter(k => k !== creatorKey);

  return {
    raw,
    keys,
    creatorKey,
    filteredKeys: filtered,
    filteredText: filtered.join(" - "),
  };
}

function getDistributionPlantsForLlcRow(llcRow) {
  const dist = buildDistributionExcludingPlant({
    productLineLabel: llcRow.product_line_label,
    creatorPlant: llcRow.plant,
  });

  // dist.filteredKeys = ["FRANKFURT", "POITIERS", ...]
  return dist.filteredKeys.map((k) => `${k} Plant`);
}

// ================== JWT helpers ==================
function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is missing in .env");
  return jwt.sign(payload, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return res.status(401).json({ error: "Missing Bearer token" });

    const token = m[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ================== UPLOAD DIR ==================
const uploadPath = path.join(process.cwd(), UPLOAD_DIR);
fs.mkdirSync(uploadPath, { recursive: true });
app.use(`/${UPLOAD_DIR}`, express.static(uploadPath));

// ✅ generated docx directory
const generatedDirAbs = path.join(uploadPath, "generated");
fs.mkdirSync(generatedDirAbs, { recursive: true });

// ✅ template path
const TEMPLATE_PATH = path.join(process.cwd(), "templates", "QUALITY_TEMPLATE.docx");
const TEMPLATE_DEP_PATH = path.join(process.cwd(), "templates", "QUALITY_TEMPLATE_DEP.docx");
const TEMPLATE_DEP_NC_PATH = path.join(process.cwd(), "templates", "QUALITY_TEMPLATE_DEP_NC.docx");

// ================== HELPERS ==================
function relPath(absPath) {
  return path.relative(process.cwd(), absPath).replaceAll("\\", "/");
}

function safeName(s) {
  return String(s || "").replace(/[^\w.\-]+/g, "_");
}

function generateDocxBuffer(templatePath, data) {
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);

  // ✅ module images
  const imageModule = new ImageModule({
    centered: false,

    // tagValue doit être un chemin local ABS (multer file.path) ou un Buffer
    getImage: (tagValue) => {
      if (!tagValue) return null; // ⚠️ si null -> tag doit être conditionnel dans le template
      if (Buffer.isBuffer(tagValue)) return tagValue;
      return fs.readFileSync(tagValue);
    },

    getSize: (imgBuffer) => {
      if (!imgBuffer) return [1, 1];

      const dim = imageSize(imgBuffer);

      // ✅ taille max (à ajuster)
      const maxWidth = 300; // px
      const ratio = dim.width ? Math.min(1, maxWidth / dim.width) : 1;

      const w = Math.round(dim.width * ratio);
      const h = Math.round(dim.height * ratio);
      return [w, h];
    },
  });

  try {
    const doc = new Docxtemplater(zip, {
      modules: [imageModule], // ✅ HERE
      paragraphLoop: true,
      linebreaks: true,

      delimiters: { start: "{{", end: "}}" },
      nullGetter: () => "",
    });

    doc.render(data);

    return doc.getZip().generate({ type: "nodebuffer" });
  } catch (err) {
    console.error("❌ DOCX render error:", err?.message);

    const e = err?.properties?.errors || [];
    if (e.length) {
      console.error("---- DOCX template errors detail ----");
      e.forEach((one, i) => {
        console.error(
          `#${i + 1}`,
          one.properties?.explanation || one.message,
          "\n  tag:", one.properties?.xtag,
          "\n  context:", one.properties?.context,
          "\n  file:", one.properties?.file
        );
      });
      console.error("-------------------------------------");
    }

    throw err;
  }
}

function formatDateDMY(date = new Date()) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

// ================== MULTER ==================
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadPath),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  },
});
const upload = multer({ storage });

// ================== VALIDATION ==================
const RootCauseSchema = z.object({
  root_cause: z.string().min(1),
  detailed_cause_description: z.string().min(1),
  solution_description: z.string().min(1),
  conclusion: z.string().min(1),
  process: z.string().min(1),
  origin: z.string().min(1),
});

const LlcSchema = z.object({
  category: z.string().min(1),
  problem_short: z.string().min(1),
  problem_detail: z.string().min(1),
  llc_type: z.string().min(1),
  customer: z.string().min(1),
  product_family: z.string().min(1),
  product_type: z.string().min(1),
  quality_detection: z.string().min(1),
  application_label: z.string().min(1),
  product_line_label: z.string().min(1),
  part_or_machine_number: z.string().min(1),
  editor: z.string().min(1),
  plant: z.string().min(1),
  failure_mode: z.string().min(1),
  conclusions: z.string().min(1),
  validator: z.string().optional(),
});

const SignUpSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  plant: z.string().min(1),
  role: z.string().min(1),
});

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  confirm_password: z.string().min(1),
  email: z.string().email().optional(),
});

const EvidenceDeploymentSchema = z.object({
  llc_id: z.number(),
  deployment_applicability: z.string().min(1, "Required"), // ✅ rename
  why_not_apply: z.string().max(2000).optional(),
  evidence_plant: z.string().min(1, "Required"),
  person: z.string().min(1, "Required").max(200),
  deployment_description: z.string().min(1, "Required").max(2000),
  pm: z.string().min(1, "Required"),
  // ✅ pour edit mode
  processingId: z.number().optional(),
  token: z.string().optional(),
  deleteAttachmentIds: z.array(z.number()).optional(),
}).superRefine((data, ctx) => {
  if (data.deployment_applicability === "Not concerned") {
    if (!data.why_not_apply || data.why_not_apply.trim().length === 0) {
      ctx.addIssue({
        path: ["why_not_apply"],
        message: "Required when plant is not concerned",
        code: z.ZodIssueCode.custom,
      });
    }
  }
});

// ================== ROUTES ==================
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ------------------ AUTH ------------------
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password, plant, role } = SignUpSchema.parse(req.body);

    const exists = await pool.query("SELECT id FROM public.users WHERE email=$1", [email]);
    if (exists.rows.length) return res.status(409).json({ error: "Email already used" });

    const password_hash = await bcrypt.hash(password, 10);

    const r = await pool.query(
      `INSERT INTO public.users (name, email, password_hash, plant, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, plant, role`,
      [name, email.toLowerCase(), password_hash, plant, role]
    );

    const user = r.rows[0];
    const token = signToken({ id: user.id, email: user.email, plant: user.plant, role: user.role });

    res.json({ token, user });
  } catch (e) {
    res.status(400).json({ error: e.message || "Signup failed" });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  try {
    const { email, password } = SignInSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const r = await pool.query(
      `SELECT id, name, email, plant, role, password_hash
       FROM public.users
       WHERE email=$1
       ORDER BY CASE role
         WHEN 'quality_manager' THEN 1
         WHEN 'plant_manager' THEN 2
         ELSE 99
       END`,
      [normalizedEmail]
    );

    if (!r.rowCount) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    for (const u of r.rows) {
      const ok = await bcrypt.compare(password, u.password_hash);
      if (ok) {
        const user = { id: u.id, name: u.name, email: u.email, plant: u.plant, role: u.role };
        const token = signToken({ id: u.id, email: u.email, plant: u.plant, role: u.role });
        return res.json({ token, user });
      }
    }

    return res.status(401).json({ error: "Invalid credentials" });
  } catch (e) {
    res.status(400).json({ error: e.message || "Signin failed" });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = ForgotPasswordSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();

    const exists = await pool.query(
      "SELECT id FROM public.users WHERE email=$1 LIMIT 1",
      [normalizedEmail]
    );
    if (!exists.rowCount) {
      return res.status(404).json({ error: "User does not exist" });
    }

    await pool.query(
      `UPDATE public.password_reset_tokens
       SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL`,
      [normalizedEmail]
    );

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO public.password_reset_tokens (email, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [normalizedEmail, tokenHash, expiresAt]
    );

    const resetLink = buildResetLink({ token, email: normalizedEmail });
    await sendResetPasswordMail({ to: normalizedEmail, resetLink });

    return res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Reset request failed" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, password, confirm_password, email } = ResetPasswordSchema.parse(req.body);

    if (password !== confirm_password) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const tokenHash = hashResetToken(token.trim());
    const record = await pool.query(
      `SELECT id, email
       FROM public.password_reset_tokens
       WHERE token_hash=$1
         AND used_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (!record.rowCount) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const tokenEmail = record.rows[0].email;
    if (email && tokenEmail !== email.toLowerCase().trim()) {
      return res.status(400).json({ error: "Email mismatch" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const updated = await pool.query(
      `UPDATE public.users SET password_hash=$1 WHERE email=$2`,
      [password_hash, tokenEmail]
    );

    if (!updated.rowCount) {
      return res.status(404).json({ error: "User not found" });
    }

    await pool.query(
      `UPDATE public.password_reset_tokens
       SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL`,
      [tokenEmail]
    );

    return res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Reset request failed" });
  }
});

// ------------------ LLC CREATE ------------------
app.post("/api/llc", requireAuth, upload.any(), async (req, res) => {
  const client = await pool.connect();
  let generatedAbsPath = "";

  if (req.user.role !== "quality_manager") {
    return res.status(403).json({ error: "Only Quality Managers can create/edit LLC" });
  }

  try {
    const llc = LlcSchema.parse(JSON.parse(req.body.llc || "{}"));
    const forcedPlant = req.user.plant;
    const forcedValidator = validatorForPlantExact(forcedPlant);
    const dist = buildDistributionExcludingPlant({
      productLineLabel: llc.product_line_label,
      creatorPlant: forcedPlant, // le plant qui a créé
    });

    const distribution_to = dist.filteredText; // ✅ texte sans le créateur
    const rootCauses = z.array(RootCauseSchema).min(1).parse(JSON.parse(req.body.rootCauses || "[]"));

    await client.query("BEGIN");

    // 1) Insert LLC
    const llcInsert = await client.query(
      `INSERT INTO public.llc (
        category, problem_short, problem_detail, llc_type, customer,
        product_family, product_type, quality_detection,
        application_label, product_line_label, part_or_machine_number,
        editor, plant, failure_mode, conclusions, validator
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id`,
      [
        llc.category,
        llc.problem_short,
        llc.problem_detail,
        llc.llc_type,
        llc.customer,
        llc.product_family,
        llc.product_type,
        llc.quality_detection,
        llc.application_label,
        llc.product_line_label,
        llc.part_or_machine_number,
        llc.editor,
        forcedPlant,
        llc.failure_mode,
        llc.conclusions,
        forcedValidator,
      ]
    );

    const llcId = llcInsert.rows[0].id;

    // 2) Insert Root Causes
    const rootCauseIds = [];
    for (let i = 0; i < rootCauses.length; i++) {
      const rc = rootCauses[i];
      const rcInsert = await client.query(
        `INSERT INTO public.llc_root_cause (
          llc_id, root_cause, detailed_cause_description,
          solution_description, conclusion, process, origin
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id`,
        [
          llcId,
          rc.root_cause,
          rc.detailed_cause_description,
          rc.solution_description,
          rc.conclusion,
          rc.process,
          rc.origin,
        ]
      );
      rootCauseIds.push(rcInsert.rows[0].id);
    }

    // 3) Insert attachments
    const files = req.files || [];

    const scopeMap = {
      badPartFiles: "BAD_PART",
      goodPartFiles: "GOOD_PART",
      situationBeforeFiles: "SITUATION_BEFORE",
      situationAfterFiles: "SITUATION_AFTER",
    };

    for (const f of files) {
      const p = relPath(f.path);

      const m = /^rootCauseFiles_(\d+)$/.exec(f.fieldname);
      if (m) {
        const idx = Number(m[1]);
        const rootCauseId = rootCauseIds[idx];
        if (rootCauseId) {
          await client.query(
            `INSERT INTO public.llc_root_cause_attachment
             (root_cause_id, filename, storage_path)
             VALUES ($1,$2,$3)`,
            [rootCauseId, f.originalname, p]
          );
        }
        continue;
      }

      const scope = scopeMap[f.fieldname];
      if (scope) {
        await client.query(
          `INSERT INTO public.llc_attachment
           (llc_id, scope, filename, storage_path)
           VALUES ($1,$2,$3,$4)`,
          [llcId, scope, f.originalname, p]
        );
      }
    }

    // 4) ✅ Generate DOCX from template & store path in generated_llc
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`Template not found: ${TEMPLATE_PATH}`);
    }

    const findFirstImagePath = (fieldname) => {
      const f = files.find((x) => x.fieldname === fieldname);
      return f ? f.path : ""; // ✅ chemin ABS
    };

    const isImage = (filename = "") =>
      /\.(png|jpe?g|gif|bmp|webp)$/i.test(filename);

    const buildEvidence = (idx) => {
      const f = files.find((x) => x.fieldname === `rootCauseFiles_${idx}`);
      if (!f) return { evidence_image: "", evidence_link: "", evidence_name: "" };

      const img = isImage(f.originalname);
      return {
        evidence_image: img ? f.path : "",                 // ✅ pour image module
        evidence_link: img ? "" : `${UPLOAD_DIR}/${path.basename(f.path)}`, // ✅ lien web
        evidence_name: f.originalname,
      };
    };

    const docData = {
      id: llcId,
      ...llc,
      distribution_to: dist.filteredText,
      created_at: formatDateDMY(),

      situation_before: findFirstImagePath("situationBeforeFiles"),
      situation_after: findFirstImagePath("situationAfterFiles"),
      bad_part: findFirstImagePath("badPartFiles"),
      good_part: findFirstImagePath("goodPartFiles"),

      // utile si ton template a une boucle rootCauses
      rootCauses: rootCauses.map((rc, i) => ({
        index: i + 1,
        ...rc,
        ...buildEvidence(i),
      })),

      // utile si ton template n'a pas de boucle
      rootCauses_text: rootCauses
        .map(
          (rc, i) =>
            `${i + 1}. ${rc.root_cause}\n- ${rc.detailed_cause_description}\n- Solution: ${rc.solution_description}\n- Conclusion: ${rc.conclusion}\n- Process: ${rc.process}\n- Origin: ${rc.origin}`
        )
        .join("\n\n"),
    };

    const buffer = generateDocxBuffer(TEMPLATE_PATH, docData);

    // 1) écrire un DOCX temporaire
    const baseName = `LLC_${llcId}_${Date.now()}_${safeName(llc.customer)}`;
    const docxAbs = path.join(generatedDirAbs, `${baseName}.docx`);
    fs.writeFileSync(docxAbs, buffer);

    // 2) convertir en PDF
    const pdfAbs = await convertDocxToPdf({
      inputDocxAbsPath: docxAbs,
      outputDirAbs: generatedDirAbs,
      sofficePath: process.env.SOFFICE_PATH,
    });

    // 3) (optionnel) supprimer le DOCX si tu ne veux PAS le garder
    try { fs.unlinkSync(docxAbs); } catch {}

    // 4) sauver le PDF comme "generated_llc"
    generatedAbsPath = pdfAbs;
    const generatedRel = relPath(pdfAbs);

    await client.query(
      `UPDATE public.llc
      SET generated_llc = $1
      WHERE id = $2`,
      [generatedRel, llcId]
    );


    // ===============================
    // PM REVIEW TOKEN (en DB) ✅
    // ===============================
    const pmToken = generatePmToken();

    await client.query(
      `
      UPDATE public.llc
      SET pm_review_token = $1,
          pm_review_token_expires = NOW() + INTERVAL '30 days',
          pm_decision = 'PENDING_FOR_VALIDATION',
          pm_decision_at = NULL,
          pm_reject_reason = NULL,
          pm_validation_date = NULL
      WHERE id = $2
      `,
      [pmToken, llcId]
    );

    await client.query("COMMIT");

    res.json({
      id: llcId,
      rootCauseCount: rootCauses.length,
      fileCount: files.length,
      generated_llc: generatedRel,
    });

    // ✅ Envoi mail APRES réponse/commit (non bloquant)
    sendPmReviewMail({
      to: forcedValidator,
      llcId,
      token: pmToken,
    }).catch((err) => {
      console.error("❌ PM review email failed:", err?.message || err);
    });

  } catch (e) {
    await client.query("ROLLBACK");

    // cleanup docx if created
    try {
      if (generatedAbsPath && fs.existsSync(generatedAbsPath)) fs.unlinkSync(generatedAbsPath);
    } catch {}

    res.status(400).json({ error: e.message || "Save failed" });
  } finally {
    client.release();
  }
});

app.get("/api/llc/:id/pm-review", async (req, res) => {
  const llcId = Number(req.params.id);
  const token = String(req.query.token || "");

  if (!llcId || !token) {
    return res.status(400).json({ error: "Missing id or token" });
  }

  const r = await pool.query(
    `
    SELECT *
    FROM public.llc
    WHERE id = $1
      AND pm_review_token = $2
      AND (pm_review_token_expires IS NULL OR pm_review_token_expires > NOW())
    `,
    [llcId, token]
  );

  if (!r.rows.length) {
    return res.status(404).json({ error: "Invalid or expired link" });
  }

  res.json(r.rows[0]);
});

async function getAdminEmail() {
  const r = await pool.query(
    `SELECT email FROM public.users WHERE role='admin' ORDER BY id ASC LIMIT 1`
  );
  return r.rows[0]?.email || "";
}

app.post("/api/llc/:id/pm-review/decision", async (req, res) => {
  const llcId = Number(req.params.id);
  const { token, action, reason } = req.body;

  if (!llcId || !token || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  if (action === "approve") {
    // 1) Update PM decision + status
    const r = await pool.query(
      `
      UPDATE public.llc
      SET pm_decision = 'APPROVED',
          pm_decision_at = NOW(),
          pm_validation_date = NOW(),
          status = 'WAITING_FOR_VALIDATION'
      WHERE id = $1 AND pm_review_token = $2
      RETURNING id
      `,
      [llcId, token]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Invalid or expired link" });

    // 2) Create FINAL token and store in DB
    const finalToken = generateFinalToken();

    await pool.query(
      `
      UPDATE public.llc
      SET final_review_token = $1,
          final_review_token_expires = NOW() + INTERVAL '30 days',
          final_decision = 'PENDING_FOR_VALIDATION',
          final_validation_date = NULL,
          final_reject_reason = NULL
      WHERE id = $2
      `,
      [finalToken, llcId]
    );

    // 3) Respond
    res.json({ ok: true });

    const { editorEmail } = await getLlcEditorEmail(llcId);
    sendPmDecisionResultMail({
      to: editorEmail,
      llcId,
      decision: "APPROVED",
    }).catch(console.error);

    // 4) Send final mail (non bloquant)
    const adminEmail = await getAdminEmail();
    if (!adminEmail) {
      console.error("❌ No admin found (role=admin). Final review mail not sent.");
    } else {
      sendFinalReviewMail({
        to: adminEmail,
        llcId,
        token: finalToken,
      }).catch((err) => {
        console.error("❌ Final review email failed:", err?.message || err);
      });
    }
    return;
  }

  const r = await pool.query(
    `
    UPDATE public.llc
    SET pm_decision = 'REJECTED',
        pm_decision_at = NOW(),
        pm_reject_reason = $3
    WHERE id = $1 AND pm_review_token = $2
    RETURNING *
    `,
    [llcId, token, reason || ""]
  );

  res.json(r.rows[0]);

  const { editorEmail } = await getLlcEditorEmail(llcId);
  sendPmDecisionResultMail({
    to: editorEmail,
    llcId,
    decision: "REJECTED",
    reason: reason || "",
  }).catch(console.error);

});

app.get("/api/llc/:id/final-review", async (req, res) => {
  const llcId = Number(req.params.id);
  const token = String(req.query.token || "");

  if (!llcId || !token) return res.status(400).json({ error: "Missing id or token" });

  const r = await pool.query(
    `
    SELECT *
    FROM public.llc
    WHERE id = $1
      AND final_review_token = $2
      AND (final_review_token_expires IS NULL OR final_review_token_expires > NOW())
    `,
    [llcId, token]
  );

  if (!r.rows.length) return res.status(404).json({ error: "Invalid or expired link" });

  res.json(r.rows[0]);
});

app.post("/api/llc/:id/final-review/decision", async (req, res) => {
  const llcId = Number(req.params.id);
  const { token, action, reason } = req.body; // "approve" | "reject" + reason

  if (!llcId || !token || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // ✅ required reason when rejecting
  if (action === "reject") {
    const r = String(reason || "").trim();
    if (r.length < 3) {
      return res.status(400).json({ error: "Reject reason is required" });
    }
  }

  const finalDecision = action === "approve" ? "APPROVED" : "REJECTED";
  const nextStatus = action === "approve" ? "DEPLOYMENT_IN_PROGRESS" : "IN_PREPARATION";
  const finalRejectReason = action === "reject" ? String(reason || "").trim() : null;
  const r = await pool.query(
    `
    UPDATE public.llc
    SET final_decision = $3,
        final_validation_date = NOW(),
        final_reject_reason = $4,
        status = $5
    WHERE id = $1
      AND final_review_token = $2
      AND (final_review_token_expires IS NULL OR final_review_token_expires > NOW())
    RETURNING *
    `,
    [llcId, token, finalDecision, finalRejectReason, nextStatus]
  );

  const { editorEmail, generated_llc } = await getLlcEditorEmail(llcId);
  sendFinalDecisionResultMail({
    to: editorEmail,
    llcId,
    decision: finalDecision,                 // "APPROVED" ou "REJECTED"
    reason: finalRejectReason || "",
    generated_llc,
  }).catch(console.error);

  if (!r.rowCount) return res.status(404).json({ error: "Invalid or expired link" });

  res.json(r.rows[0]);

  if (action === "approve") {
    const llcRow = r.rows[0];

    const dist = buildDistributionExcludingPlant({
      productLineLabel: llcRow.product_line_label,
      creatorPlant: llcRow.plant,
    });

    const distributedPlants = (dist.filteredKeys || []).map(k => `${k} Plant`);
    const toList = await getDistributionRecipientsEmails({ plantKeys: dist.filteredKeys });

    // 1) mail aux plants (QM + PM)
    sendDistributionMail({
      toList,
      llcId,
      productLineLabel: llcRow.product_line_label,
      creatorPlant: llcRow.plant,
      generated_llc: llcRow.generated_llc,
    }).catch((err) => console.error("❌ Distribution mail failed:", err?.message || err));

    // 2) mail informatif à l'admin (liste des plants)
    const adminEmail = await getAdminEmail();
    sendDistributionInfoToAdminMail({
      to: adminEmail,
      llcId,
      productLineLabel: llcRow.product_line_label,
      creatorPlant: llcRow.plant,
      distributedPlants,
      generated_llc: llcRow.generated_llc,
    }).catch((err) => console.error("❌ Admin distribution info mail failed:", err?.message || err));
  }
});



app.get("/api/dep-processing/:processingId/review", async (req, res) => {
  const processingId = Number(req.params.processingId);
  const token = String(req.query.token || "");

  if (!processingId || !token) {
    return res.status(400).json({ error: "Missing processingId or token" });
  }

  const r = await pool.query(
    `
    SELECT
      p.*,
      l.id AS llc_id,
      l.problem_short,
      l.customer,
      l.plant,
      l.created_at
    FROM public.llc_deployment_processing p
    JOIN public.llc l ON l.id = p.llc_id
    WHERE p.id = $1
      AND p.dep_review_token = $2
      AND (p.dep_review_token_expires IS NULL OR p.dep_review_token_expires > NOW())
    `,
    [processingId, token]
  );

  if (!r.rowCount) return res.status(404).json({ error: "Invalid or expired link" });

  res.json(r.rows[0]);
});

app.post("/api/dep-processing/:processingId/review/decision", async (req, res) => {
  const client = await pool.connect();

  try {
    const processingId = Number(req.params.processingId);
    const { token, action, reason } = req.body;

    if (!processingId || !token || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    if (action === "reject") {
      const r = String(reason || "").trim();
      if (r.length < 3) return res.status(400).json({ error: "Reject reason is required" });
    }

    const decision = action === "approve" ? "APPROVED" : "REJECTED";
    const rejectReason = action === "reject" ? String(reason || "").trim() : null;

    await client.query("BEGIN");

    // 1) update processing decision (admin)
    const upd = await client.query(
      `
      UPDATE public.llc_deployment_processing
      SET dep_decision = $3,
          dep_decision_at = NOW(),
          dep_reject_reason = $4
      WHERE id = $1
        AND dep_review_token = $2
        AND (dep_review_token_expires IS NULL OR dep_review_token_expires > NOW())
      RETURNING *
      `,
      [processingId, token, decision, rejectReason]
    );

    if (!upd.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Invalid or expired link" });
    }

    const processingRow = upd.rows[0];

    // 2) reload llc (source de vérité) to compute targets
    const llcRes = await client.query(
      `SELECT id, status, plant, product_line_label FROM public.llc WHERE id=$1`,
      [processingRow.llc_id]
    );
    if (!llcRes.rowCount) throw new Error("LLC not found");
    const llcRow = llcRes.rows[0];

    // 3) compute target plants
    const dist = buildDistributionExcludingPlant({
      productLineLabel: llcRow.product_line_label,
      creatorPlant: llcRow.plant,
    });
    const targetPlants = (dist.filteredKeys || []).map((k) => `${k} Plant`);

    // 4) read all decisions for those target plants
    const decRes = await client.query(
      `
      SELECT evidence_plant, dep_decision
      FROM public.llc_deployment_processing
      WHERE llc_id = $1
        AND evidence_plant = ANY($2::text[])
      `,
      [processingRow.llc_id, targetPlants]
    );

    const decisions = decRes.rows || [];
    const anyRejected = decisions.some((x) => x.dep_decision === "REJECTED");
    const allApproved =
      targetPlants.length > 0 &&
      targetPlants.every((plant) =>
        decisions.some((x) => x.evidence_plant === plant && x.dep_decision === "APPROVED")
      );

    // 5) update LLC status
    if (anyRejected) {
      await client.query(
        `UPDATE public.llc SET status='DEPLOYMENT_REJECTED' WHERE id=$1`,
        [processingRow.llc_id]
      );
    } else if (allApproved) {
      await client.query(
        `UPDATE public.llc SET status='DEPLOYMENT_VALIDATED' WHERE id=$1`,
        [processingRow.llc_id]
      );
    } else {
      // on peut laisser DEPLOYMENT_PROCESSING
      // (optionnel) enforce it:
      // await client.query(`UPDATE public.llc SET status='DEPLOYMENT_PROCESSING' WHERE id=$1`, [processingRow.llc_id]);
    }

    let reworkMailAfterCommit = null;

    if (decision === "REJECTED") {
      // 1) générer token rework
      const reworkToken = generateDepReworkToken();

      // 2) stocker token
      await client.query(
        `
        UPDATE public.llc_deployment_processing
        SET dep_rework_token = $1,
            dep_rework_token_expires = NOW() + INTERVAL '30 days'
        WHERE id = $2
        `,
        [reworkToken, processingId]
      );

      // 3) récupérer email person 
      const personEmail = await getProcessingPersonEmail(processingRow.id);

      // 4) préparer mail après commit (comme tu fais ailleurs)
      reworkMailAfterCommit = async () => {
        if (!editorEmail) {
          console.error("❌ No editor email found. Rework mail not sent.");
          return;
        }
        await sendDepReworkMailToEditor({
          to: editorEmail,
          llcId: processingRow.llc_id,
          processingId: processingRow.id,
          token: reworkToken,
          reason: rejectReason || "",
          evidencePlant: processingRow.evidence_plant,
        });
      };
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      processing: processingRow,
      llcStatus:
        anyRejected ? "DEPLOYMENT_REJECTED" : allApproved ? "DEPLOYMENT_VALIDATED" : llcRow.status,
    });
    Promise.resolve()
      .then(() => reworkMailAfterCommit?.())
      .catch((err) => console.error("❌ DEP rework email failed:", err?.message || err));

  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(400).json({ error: e?.message || "Decision failed" });
  } finally {
    client.release();
  }
});

app.get("/api/dep-processing/:processingId/rework", async (req, res) => {
  const processingId = Number(req.params.processingId);
  const token = String(req.query.token || "");

  if (!processingId || !token) {
    return res.status(400).json({ error: "Missing processingId or token" });
  }

  const r = await pool.query(
    `
    SELECT
      p.*,
      l.id AS llc_id,
      l.problem_short,
      l.customer,
      l.plant,
      l.product_line_label
    FROM public.llc_deployment_processing p
    JOIN public.llc l ON l.id = p.llc_id
    WHERE p.id = $1
      AND p.dep_rework_token = $2
      AND (p.dep_rework_token_expires IS NULL OR p.dep_rework_token_expires > NOW())
    `,
    [processingId, token]
  );

  if (!r.rowCount) return res.status(404).json({ error: "Invalid or expired link" });

  const row = r.rows[0];

  // ✅ charger les fichiers déjà stockés
  const att = await pool.query(
    `
    SELECT id, scope, filename, storage_path
    FROM public.llc_deployment_processing_attachment
    WHERE processing_id = $1
    ORDER BY id ASC
    `,
    [processingId]
  );

  const attachments = (att.rows || []).map(a => ({
    id: a.id,
    scope: a.scope,             
    filename: a.filename,
    storage_path: a.storage_path,
    url: publicFileUrl(a.storage_path),
  }));

  res.json({
    processingId: row.id,
    llc_id: row.llc_id,
    evidence_plant: row.evidence_plant,
    deployment_applicability: row.deployment_applicability,
    why_not_apply: row.why_not_apply,
    person: row.person,
    deployment_description: row.deployment_description,
    pm: row.pm,
    dep_reject_reason: row.dep_reject_reason,

    attachments,
  });
});


// ------------------ LLC LIST ------------------
app.get("/api/llc", requireAuth, async (req, res) => {
  const status = (req.query.status || "").trim();

  try {
    const params = [];
    const whereParts = [];

    // ✅ filtre plant seulement si pas admin (sur la LLC créatrice)
    if (req.user.role !== "admin") {
      params.push(req.user.plant);
      whereParts.push(`l.plant = $${params.length}`);
    }

    // =========================================================
    // ✅ CAS SPECIAL: DEPLOYMENT => 1 ligne par plant
    // =========================================================
    const DEP_STATUSES_WITH_PROCESSING = [
      "DEPLOYMENT_PROCESSING",
      "DEPLOYMENT_VALIDATED",
      "DEPLOYMENT_REJECTED",
    ];

    if (DEP_STATUSES_WITH_PROCESSING.includes(status)) {
      params.push(status);
      whereParts.push(`l.status = $${params.length}::text`);

      const where = `WHERE ${whereParts.join(" AND ")}`;

      const q = `
        SELECT
          l.*,

          -- champs processing (une ligne par plant)
          p.id AS processing_id,
          p.evidence_plant,
          p.deployment_applicability,
          p.why_not_apply,
          p.person,
          p.deployment_description,
          p.pm,
          p.generated_dep,
          p.deployment_date,

          -- attachments LLC
          COALESCE(
            json_agg(
              DISTINCT jsonb_build_object(
                'id', a.id,
                'scope', a.scope,
                'filename', a.filename,
                'storage_path', a.storage_path
              )
            ) FILTER (WHERE a.id IS NOT NULL),
            '[]'::json
          ) AS processing_attachments

        FROM public.llc l
        INNER JOIN public.llc_deployment_processing p ON p.llc_id = l.id
        LEFT JOIN public.llc_deployment_processing_attachment a ON a.processing_id = p.id
        ${where}
        GROUP BY l.id, p.id
        ORDER BY l.created_at DESC, p.deployment_date DESC
      `;

      const r = await pool.query(q, params);
      return res.json(r.rows);
    }

    // =========================================================
    // ✅ CAS GENERAL (inchangé): une ligne = une LLC
    // =========================================================
    if (status) {
      params.push(status);
      whereParts.push(`l.status = $${params.length}::text`);
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const q = `
      SELECT
        l.*,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', a.id,
              'scope', a.scope,
              'filename', a.filename,
              'storage_path', a.storage_path
            )
          ) FILTER (WHERE a.id IS NOT NULL),
          '[]'::json
        ) AS attachments
      FROM public.llc l
      LEFT JOIN public.llc_attachment a ON a.llc_id = l.id
      ${where}
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `;

    const r = await pool.query(q, params);
    const ids = r.rows.map(x => x.id);

    let doneMap = {};

    if (ids.length) {
      const doneRes = await pool.query(
        `
        SELECT llc_id, array_agg(DISTINCT evidence_plant) AS done_plants
        FROM public.llc_deployment_processing
        WHERE llc_id = ANY($1::int[])
        GROUP BY llc_id
        `,
        [ids]
      );

      doneMap = doneRes.rows.reduce((acc, row) => {
        acc[row.llc_id] = row.done_plants || [];
        return acc;
      }, {});
    }

    const enriched = r.rows.map((llc) => {
      if (llc.status !== "DEPLOYMENT_IN_PROGRESS") return llc;

      const dist = buildDistributionExcludingPlant({
        productLineLabel: llc.product_line_label,
        creatorPlant: llc.plant,
      });

      const targets = (dist.filteredKeys || []).map(k => `${k} Plant`);
      const donePlants = doneMap[llc.id] || [];

      const pending = targets.filter(p => !donePlants.includes(p));
      const done = targets.filter(p => donePlants.includes(p));

      const deployment_progress = [
        pending.length ? `Pending for: ${pending.join(" - ")}` : null,
        done.length ? `Done by: ${done.join(" - ")}` : null,
      ].filter(Boolean).join(" | ");

      return { ...llc, deployment_progress };
    });

    res.json(enriched);

  } catch (e) {
    res.status(500).json({ error: e.message || "List failed" });
  }
});


// ------------------ LLC DETAILS ------------------
app.get("/api/llc/:id", requireAuth, async (req, res) => {
  const llcId = Number(req.params.id);
  if (!llcId) return res.status(400).json({ error: "Invalid id" });

  try {
    const llcRes = await pool.query(`SELECT * FROM public.llc WHERE id = $1`, [llcId]);
    const llc = llcRes.rows[0];
    if (req.user.role !== "admin" && llc.plant !== req.user.plant) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!llc) return res.status(404).json({ error: "Not found" });

    const attRes = await pool.query(
      `SELECT id, scope, filename, storage_path
       FROM public.llc_attachment
       WHERE llc_id = $1
       ORDER BY id ASC`,
      [llcId]
    );

    const rcRes = await pool.query(
      `SELECT *
       FROM public.llc_root_cause
       WHERE llc_id = $1
       ORDER BY id ASC`,
      [llcId]
    );

    const rcIds = rcRes.rows.map((r) => r.id);

    let rcAtt = [];
    if (rcIds.length) {
      const rcAttRes = await pool.query(
        `SELECT id, root_cause_id, filename, storage_path
         FROM public.llc_root_cause_attachment
         WHERE root_cause_id = ANY($1::int[])
         ORDER BY id ASC`,
        [rcIds]
      );
      rcAtt = rcAttRes.rows;
    }

    const byRc = rcAtt.reduce((acc, a) => {
      (acc[a.root_cause_id] ||= []).push(a);
      return acc;
    }, {});

    const rootCauses = rcRes.rows.map((rc) => ({
      ...rc,
      attachments: byRc[rc.id] || [],
    }));

    res.json({
      ...llc,
      attachments: attRes.rows,
      rootCauses,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Read failed" });
  }
});

app.put("/api/llc/:id/pm-validate", requireAuth, async (req, res) => {
  const llcId = Number(req.params.id);
  if (!llcId) return res.status(400).json({ error: "Invalid id" });

  try {
    // Ici tu peux aussi contrôler que req.user.email == validator (PM) si tu veux sécuriser.
    const r = await pool.query(
      `
      UPDATE public.llc
      SET pm_validation_date = NOW()
      WHERE id = $1
      RETURNING id, pm_validation_date
      `,
      [llcId]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Not found" });

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message || "Validation failed" });
  }
});

app.put("/api/llc/:id", requireAuth, upload.any(), async (req, res) => {
  const client = await pool.connect();
  const llcId = Number(req.params.id);
  let newPmToken = "";
  let validatorEmail = "";
  if (req.user.role !== "quality_manager") {
    return res.status(403).json({ error: "Only Quality Managers can create/edit LLC" });
  }

  try {
    const llc = LlcSchema.parse(JSON.parse(req.body.llc || "{}"));
    const forcedPlant = req.user.plant;
    const forcedValidator = validatorForPlantExact(forcedPlant);
    validatorEmail = forcedValidator;
    const distribution_to = distributionToForProductLine(llc.product_line_label);
    const rootCauses = z.array(RootCauseSchema.extend({ id: z.number().optional() }))
      .min(1)
      .parse(JSON.parse(req.body.rootCauses || "[]"));

    const del = JSON.parse(req.body.delete || "{}"); // { llcAttachments:[], rootCauseAttachments:[], rootCauses:[] }
    const files = req.files || [];

    await client.query("BEGIN");

    // 0) sécurité: editable seulement si REJECTED (si tu veux)
    const chk = await client.query(
      "SELECT pm_decision, final_decision FROM public.llc WHERE id=$1",
      [llcId]
    );
    if (!chk.rowCount) throw new Error("Not found");

    const pmRejected = chk.rows[0].pm_decision === "REJECTED";
    const finalRejected = chk.rows[0].final_decision === "REJECTED";

    if (!pmRejected && !finalRejected) {
      throw new Error("Editable only if PM decision is REJECTED or Final decision is REJECTED");
    }

    // 1) UPDATE llc (tous champs)
    await client.query(
      `UPDATE public.llc
       SET category=$1, problem_short=$2, problem_detail=$3,
           llc_type=$4, customer=$5, product_family=$6, product_type=$7,
           quality_detection=$8, application_label=$9, product_line_label=$10, part_or_machine_number=$11,
           editor=$12, plant=$13, failure_mode=$14, conclusions=$15, validator=$16
       WHERE id=$17`,
      [
        llc.category, llc.problem_short, llc.problem_detail,
        llc.llc_type, llc.customer, llc.product_family, llc.product_type,
        llc.quality_detection, llc.application_label, llc.product_line_label, llc.part_or_machine_number,
        llc.editor, forcedPlant, llc.failure_mode, llc.conclusions, forcedValidator,
        llcId
      ]
    );

    // 2) ROOT CAUSES: update/insert + delete removed
    // delete root causes explicitly removed (del.rootCauses)
    if (Array.isArray(del.rootCauses) && del.rootCauses.length) {
      await client.query(`DELETE FROM public.llc_root_cause WHERE id = ANY($1::int[]) AND llc_id=$2`, [del.rootCauses, llcId]);
    }

    // upsert root causes one by one
    const rootCauseIds = [];
    for (let i = 0; i < rootCauses.length; i++) {
      const rc = rootCauses[i];
      if (rc.id) {
        const r = await client.query(
          `UPDATE public.llc_root_cause
           SET root_cause=$1, detailed_cause_description=$2, solution_description=$3, conclusion=$4, process=$5, origin=$6
           WHERE id=$7 AND llc_id=$8
           RETURNING id`,
          [rc.root_cause, rc.detailed_cause_description, rc.solution_description, rc.conclusion, rc.process, rc.origin, rc.id, llcId]
        );
        rootCauseIds[i] = r.rows[0].id;
      } else {
        const r = await client.query(
          `INSERT INTO public.llc_root_cause (llc_id, root_cause, detailed_cause_description, solution_description, conclusion, process, origin)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [llcId, rc.root_cause, rc.detailed_cause_description, rc.solution_description, rc.conclusion, rc.process, rc.origin]
        );
        rootCauseIds[i] = r.rows[0].id;
      }
    }

    // 3) DELETE attachments (DB + disque)
    // A) llc attachments
    if (Array.isArray(del.llcAttachments) && del.llcAttachments.length) {
      const r = await client.query(
        `SELECT storage_path FROM public.llc_attachment WHERE id = ANY($1::int[]) AND llc_id=$2`,
        [del.llcAttachments, llcId]
      );
      await client.query(`DELETE FROM public.llc_attachment WHERE id = ANY($1::int[]) AND llc_id=$2`, [del.llcAttachments, llcId]);
      // TODO: supprimer physiquement les fichiers sur disque (fs.unlinkSync) avec uploadPath + storage_path
    }

    // B) root cause attachments
    if (Array.isArray(del.rootCauseAttachments) && del.rootCauseAttachments.length) {
      const r = await client.query(
        `SELECT storage_path FROM public.llc_root_cause_attachment WHERE id = ANY($1::int[])`,
        [del.rootCauseAttachments]
      );
      await client.query(`DELETE FROM public.llc_root_cause_attachment WHERE id = ANY($1::int[])`, [del.rootCauseAttachments]);
      // TODO unlink disque
    }

    // 4) INSERT new attachments (comme ton create)
    const scopeMap = {
      badPartFiles: "BAD_PART",
      goodPartFiles: "GOOD_PART",
      situationBeforeFiles: "SITUATION_BEFORE",
      situationAfterFiles: "SITUATION_AFTER",
    };

    for (const f of files) {
      const p = relPath(f.path);

      const m = /^rootCauseFiles_(\d+)$/.exec(f.fieldname);
      if (m) {
        const idx = Number(m[1]);
        const rootCauseId = rootCauseIds[idx];
        if (rootCauseId) {
          await client.query(
            `INSERT INTO public.llc_root_cause_attachment (root_cause_id, filename, storage_path)
             VALUES ($1,$2,$3)`,
            [rootCauseId, f.originalname, p]
          );
        }
        continue;
      }

      const scope = scopeMap[f.fieldname];
      if (scope) {
        await client.query(
          `INSERT INTO public.llc_attachment (llc_id, scope, filename, storage_path)
           VALUES ($1,$2,$3,$4)`,
          [llcId, scope, f.originalname, p]
        );
      }
    }

    // 5) reset decision + set PENDING
    newPmToken = generatePmToken();

    await client.query(
      `
      UPDATE public.llc
      SET pm_review_token = $1,
          pm_review_token_expires = NOW() + INTERVAL '30 days',
          pm_decision = 'PENDING_FOR_VALIDATION',
          pm_decision_at = NULL,
          pm_reject_reason = NULL,
          pm_validation_date = NULL,
          
          final_decision = NULL,
          final_validation_date = NULL,
          final_reject_reason = NULL,
          final_review_token = NULL,
          final_review_token_expires = NULL
      WHERE id = $2
      `,
      [newPmToken, llcId]
    );

    // 6) ✅ regenerate docx (like create) and update generated_llc
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`Template not found: ${TEMPLATE_PATH}`);
    }

    // reload DB data (source of truth)
    const llcRes = await client.query(`SELECT * FROM public.llc WHERE id=$1`, [llcId]);
    const llcDb = llcRes.rows[0];

    const attRes = await client.query(
      `SELECT id, scope, filename, storage_path
      FROM public.llc_attachment
      WHERE llc_id=$1
      ORDER BY id ASC`,
      [llcId]
    );

    const rcRes = await client.query(
      `SELECT *
      FROM public.llc_root_cause
      WHERE llc_id=$1
      ORDER BY id ASC`,
      [llcId]
    );

    const rcIds = rcRes.rows.map((r) => r.id);
    let rcAtt = [];
    if (rcIds.length) {
      const rcAttRes = await client.query(
        `SELECT id, root_cause_id, filename, storage_path
        FROM public.llc_root_cause_attachment
        WHERE root_cause_id = ANY($1::int[])
        ORDER BY id ASC`,
        [rcIds]
      );
      rcAtt = rcAttRes.rows;
    }

    const byRc = rcAtt.reduce((acc, a) => {
      (acc[a.root_cause_id] ||= []).push(a);
      return acc;
    }, {});

    const rootCausesDb = rcRes.rows.map((rc, i) => ({
      index: i + 1,
      ...rc,
      attachments: byRc[rc.id] || [],
    }));

    // helper to pick first attachment by scope
    const pickFirstScopeAbs = (scope) => {
      const a = attRes.rows.find((x) => x.scope === scope);
      if (!a) return "";
      // storage_path is relative like "uploads/xxx" or "xxx" depending your relPath
      return path.join(process.cwd(), a.storage_path);
    };

    // build evidence per root cause: choose first attachment (or none)
    const isImage = (filename = "") => /\.(png|jpe?g|gif|bmp|webp)$/i.test(filename);

    const buildEvidenceFromDb = (rc) => {
      const a = (rc.attachments || [])[0];
      if (!a) return { evidence_image: "", evidence_link: "", evidence_name: "" };

      const abs = path.join(process.cwd(), a.storage_path);
      const img = isImage(a.filename);

      return {
        evidence_image: img ? abs : "",
        evidence_link: img ? "" : `${a.storage_path}`, // ou `${UPLOAD_DIR}/...` selon ton front
        evidence_name: a.filename,
      };
    };

    const docData = {
      id: llcId,
      ...llcDb,
      distribution_to,

      created_at: formatDateDMY(llcDb.created_at || new Date()),

      // images (first by scope)
      situation_before: pickFirstScopeAbs("SITUATION_BEFORE"),
      situation_after: pickFirstScopeAbs("SITUATION_AFTER"),
      bad_part: pickFirstScopeAbs("BAD_PART"),
      good_part: pickFirstScopeAbs("GOOD_PART"),

      rootCauses: rootCausesDb.map((rc) => ({
        ...rc,
        ...buildEvidenceFromDb(rc),
      })),

      rootCauses_text: rootCausesDb
        .map(
          (rc, i) =>
            `${i + 1}. ${rc.root_cause}\n- ${rc.detailed_cause_description}\n- Solution: ${rc.solution_description}\n- Conclusion: ${rc.conclusion}\n- Process: ${rc.process}\n- Origin: ${rc.origin}`
        )
        .join("\n\n"),
    };

    const buffer = generateDocxBuffer(TEMPLATE_PATH, docData);

    const baseName = `LLC_${llcId}_${Date.now()}_${safeName(llcDb.customer)}`;
    const docxAbs = path.join(generatedDirAbs, `${baseName}.docx`);
    fs.writeFileSync(docxAbs, buffer);

    const pdfAbs = await convertDocxToPdf({
      inputDocxAbsPath: docxAbs,
      outputDirAbs: generatedDirAbs,
      sofficePath: process.env.SOFFICE_PATH,
    });

    try { fs.unlinkSync(docxAbs); } catch {}

    const generatedRel = relPath(pdfAbs);

    await client.query(
      `UPDATE public.llc
      SET generated_llc = $1
      WHERE id = $2`,
      [generatedRel, llcId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
    sendPmReviewMail({
      to: validatorEmail,
      llcId,
      token: newPmToken,
    }).catch((err) => {
      console.error("❌ PM review re-email failed:", err?.message || err);
    });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Update failed" });
  } finally {
    client.release();
  }
});

app.delete("/api/llc/:id", requireAuth, async (req, res) => {
  const llcId = Number(req.params.id);
  if (!llcId) return res.status(400).json({ error: "Invalid id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // (Optionnel) Sécurité: autoriser delete فقط للـ plant متاع user
    const chk = await client.query(
      "SELECT id FROM public.llc WHERE id=$1 AND plant=$2",
      [llcId, req.user.plant]
    );
    if (!chk.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    // Supprimer d'abord les dépendances (si pas ON DELETE CASCADE)
    await client.query("DELETE FROM public.llc_root_cause_attachment WHERE root_cause_id IN (SELECT id FROM public.llc_root_cause WHERE llc_id=$1)", [llcId]);
    await client.query("DELETE FROM public.llc_root_cause WHERE llc_id=$1", [llcId]);
    await client.query("DELETE FROM public.llc_attachment WHERE llc_id=$1", [llcId]);

    // Enfin supprimer llc
    await client.query("DELETE FROM public.llc WHERE id=$1", [llcId]);

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message || "Delete failed" });
  } finally {
    client.release();
  }
});



/* =========================
   Evidence Deployment
========================= */

/* =========================
   ✅ GET LLC LIST 
========================= */
app.get("/api/llc-list", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, problem_short
      FROM public.llc
      WHERE status = 'DEPLOYMENT_IN_PROGRESS'
      ORDER BY problem_short ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error fetching LLC list:", error);
    res.status(500).json({ error: "Failed to load LLC list" });
  }
});

app.get("/api/llc-list/rejected", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, problem_short
      FROM public.llc
      WHERE status = 'DEPLOYMENT_REJECTED'
      ORDER BY problem_short ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error fetching rejected LLC list:", error);
    res.status(500).json({ error: "Failed to load LLC list" });
  }
});

app.post("/api/evidence-deployment", upload.any(), async (req, res) => {
  const client = await pool.connect();

  // pour envoyer le mail après COMMIT
  let mailAfterCommit = null;

  try {
    const payload = EvidenceDeploymentSchema.parse(
      JSON.parse(req.body.evidenceDeployment || "{}")
    );

    // ✅ vérifier LLC existe + statut
    const llcRes = await client.query(
      `
      SELECT id, status, plant, product_line_label
      FROM public.llc
      WHERE id = $1
      `,
      [payload.llc_id]
    );

    if (!llcRes.rowCount) {
      return res.status(404).json({ error: "LLC not found" });
    }

    const llcRow = llcRes.rows[0];
    if (llcRow.status !== "DEPLOYMENT_IN_PROGRESS") {
      return res.status(400).json({ error: "LLC is not in DEPLOYMENT_IN_PROGRESS" });
    }

    await client.query("BEGIN");

    // ✅ 1) Insert processing row
    const ins = await client.query(
      `
      INSERT INTO public.llc_deployment_processing
        (llc_id, evidence_plant, deployment_applicability,
         why_not_apply, person, deployment_description, pm)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        payload.llc_id,
        payload.evidence_plant,
        payload.deployment_applicability,
        payload.why_not_apply || "",
        payload.person,
        payload.deployment_description,
        payload.pm,
      ]
    );

    const processingRow = ins.rows[0];
    const processingId = processingRow.id;

    // ✅ 2) Save uploaded files into llc_deployment_processing_attachment
    const files = req.files || [];
    const scopeMap = {
      beforeDepFiles: "BEFORE_DEP",
      afterDepFiles: "AFTER_DEP",
      evidenceFiles: "EVIDENCE_FILE",
    };

    for (const f of files) {
      const scope = scopeMap[f.fieldname];
      if (!scope) continue;

      const storagePath = relPath(f.path);
      await client.query(
        `
        INSERT INTO public.llc_deployment_processing_attachment
          (processing_id, scope, filename, storage_path)
        VALUES ($1,$2,$3,$4)
        `,
        [processingId, scope, f.originalname, storagePath]
      );
    }

    // ✅ 3) Reload full LLC (source vérité) + générer PDF DEP tout de suite (par plant)
    const llcFull = await client.query(`SELECT * FROM public.llc WHERE id=$1`, [payload.llc_id]);
    const llcRowFull = llcFull.rows[0];

    const generatedRel = await generateDeploymentPdfForProcessing({
      client,
      llcRow: llcRowFull,
      processingRow: processingRow,
    });

    await client.query(
      `
      UPDATE public.llc_deployment_processing
      SET generated_dep = $1
      WHERE id = $2
      `,
      [generatedRel, processingId]
    );

    // ✅ 4) créer token + statut PENDING pour l’admin
    const depToken = generateDepToken();

    await client.query(
      `
      UPDATE public.llc_deployment_processing
      SET dep_review_token = $1,
          dep_review_token_expires = NOW() + INTERVAL '30 days',
          dep_decision = 'PENDING_FOR_APPROVAL',
          dep_decision_at = NULL,
          dep_reject_reason = NULL
      WHERE id = $2
      `,
      [depToken, processingId]
    );

    // ✅ 5) Check si tous les plants ont répondu -> move LLC to DEPLOYMENT_PROCESSING (comme avant)
    const dist = buildDistributionExcludingPlant({
      productLineLabel: llcRow.product_line_label,
      creatorPlant: llcRow.plant,
    });

    const targetPlants = (dist.filteredKeys || []).map((k) => `${k} Plant`);
    const targetCount = targetPlants.length;

    const doneRes = await client.query(
      `
      SELECT COUNT(DISTINCT evidence_plant) AS done_count
      FROM public.llc_deployment_processing
      WHERE llc_id = $1
        AND evidence_plant = ANY($2::text[])
      `,
      [payload.llc_id, targetPlants]
    );

    const doneCount = Number(doneRes.rows[0]?.done_count || 0);

    if (targetCount > 0 && doneCount >= targetCount) {
      await client.query(
        `UPDATE public.llc SET status='DEPLOYMENT_PROCESSING' WHERE id=$1`,
        [payload.llc_id]
      );
    }

    // ✅ préparer l’envoi mail (MAIS après COMMIT)
    const adminEmail = await getAdminEmail();
    mailAfterCommit = async () => {
      if (!adminEmail) {
        console.error("❌ No admin found (role=admin). DEP review mail not sent.");
        return;
      }
      await sendDepReviewMail({
        to: adminEmail,
        llcId: payload.llc_id,
        processingId,
        token: depToken,
        evidencePlant: payload.evidence_plant,
      });
    };

    await client.query("COMMIT");

    // ✅ réponse
    res.json({
      ok: true,
      saved: { ...processingRow, generated_dep: generatedRel },
      fileCount: files.length,
    });

    // ✅ mail non bloquant après commit
    Promise.resolve()
      .then(() => mailAfterCommit?.())
      .catch((err) => console.error("❌ DEP review email failed:", err?.message || err));
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    res.status(400).json({ error: e?.message || "Save failed" });
  } finally {
    client.release();
  }
});


// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
});
