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

// ================== ENV ==================
dotenv.config();

// ================== CONFIG ==================
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// ================== APP ==================
const app = express();

// ✅ JSON body parser (needed for auth)
app.use(express.json({ limit: "2mb" }));

// ================== CORS MANUEL ==================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
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


function generatePmToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendPmReviewMail({ to, llcId, token }) {
  const FRONTEND_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

  const reviewLink = `${FRONTEND_URL}/pm-review/${llcId}?token=${encodeURIComponent(token)}`;

  const html = `
    <div style="font-family:Segoe UI, Arial, sans-serif; line-height:1.6">
      <h2>LLC #${llcId} – Validation requise</h2>

      <p>
        Un <b>Lesson Learned (LLC)</b> a été soumis et nécessite votre validation.
      </p>

      <p>
        👉 Cliquez sur le lien ci-dessous pour consulter le LLC et valider ou refuser :
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
          Ouvrir le LLC pour validation
        </a>
      </p>

      <p style="font-size:12px;color:#6b7280">
        Ce lien est personnel et temporaire.<br/>
        Si vous n’êtes pas le bon validateur, ignorez ce message.
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject: `LLC #${llcId} – Validation PM requise`,
    html
  });

  console.log(`📨 Mail de validation envoyé à ${to} pour LLC #${llcId}`);
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
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
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
  { name: "Ons Ghariani", email: "ons.ghariani@avocarbon.com", plant: "TEST Plant", password: "azertycv" },
  { name: "Gayathri N", email: "gayathri.n@avocarbon.com", plant: "CHENNAI Plant", password: "Gayathri@2026!" },
  { name: "Weijiang Peng", email: "weijiang.peng@avocarbon.com", plant: "TIANJIN Plant", password: "WeiJiang@2026!" },
  { name: "Yang Yang", email: "yang.yang@avocarbon.com", plant: "TIANJIN Plant", password: "Yang@2026!" },
  { name: "Daniel Beil", email: "daniel.beil@avocarbon.com", plant: "FRANKFURT Plant", password: "Daniel@2026!" },
  { name: "Dagmar Ansinn", email: "dagmar.ansinn@avocarbon.com", plant: "FRANKFURT Plant", password: "Dagmar@2026!" },
  { name: "Louis Lu", email: "louis.lu@avocarbon.com", plant: "ANHUI Plant", password: "Louis@2026!" },
  { name: "Jin Li", email: "jin.li@avocarbon.com", plant: "ANHUI Plant", password: "Jin@2026!" },
  { name: "Vivian Wang", email: "vivian.wang@avocarbon.com", plant: "KUNSHAN Plant", password: "Vivian@2026!" },
  { name: "Lassaad Charaabi", email: "lassaad.charaabi@avocarbon.com", plant: "SCEET Plant", password: "Lassaad@2026!" },
  { name: "Imed Benalaya", email: "imed.benalaya@avocarbon.com", plant: "SCEET Plant", password: "Imed@2026!" },
  { name: "Hector Olivares", email: "hector.olivares@avocarbon.com", plant: "MONTERREY Plant", password: "Hector@2026!" },
  { name: "Allan Riegel", email: "allan.riegel@avocarbon.com", plant: "KUNSHAN Plant", password: "Allan@2026!" },
  { name: "Sridhar B", email: "sridhar.b@avocarbon.com", plant: "CHENNAI Plant", password: "Sridhar@26!" },
  { name: "Marco Estrada", email: "marco.estrada@avocarbon.com", plant: "MONTERREY Plant", password: "Marco@2026!" },
  { name: "Florence Paradis", email: "florence.paradis@avocarbon.com", plant: "CYCLAM Plant", password: "Florence@2026!" },
  { name: "Jean-Francois Savarieau", email: "jean-francois.savarieau@avocarbon.com", plant: "POITIERS Plant", password: "Jean@2026!" },
];

function validateUser(u) {
  if (!u?.name || !u?.email || !u?.plant || !u?.password) return false;
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
          INSERT INTO users (name, email, plant, password_hash)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (email) DO NOTHING
          RETURNING email
          `,
          [u.name, email, u.plant, passwordHash]
        );

        if (r.rowCount === 1) created.push(email);
        else skipped.push(email);
      } else {
        const r = await client.query(
          `
          INSERT INTO users (name, email, plant, password_hash)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (email) DO UPDATE
            SET name = EXCLUDED.name,
                plant = EXCLUDED.plant,
                password_hash = EXCLUDED.password_hash
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
  BRUSH: "GERMANY - POITIERS - TIANJIN - CHENNAI",
  CHOKES: "TUNISIA - MEXICO - ANHUI - KUNSHAN - CHENNAI",
  ASSEMBLY: "TUNISIA - MEXICO - ANHUI - KUNSHAN - POITIERS",
  SEALS: "AMIENS - CHENNAI - TUNISIA - MEXICO",
  INJECTION: "TUNISIA - MEXICO",
  ALL: "GERMANY - POITIERS - TIANJIN - CHENNAI - TUNISIA - MEXICO - ANHUI - KUNSHAN - AMIENS",
};

function distributionToForProductLine(label) {
  const key = String(label || "").trim().toUpperCase();
  return DISTRIBUTION_BY_PRODUCT_LINE[key] || "";
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

// ================== ensure users table ==================
async function ensureUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
        id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        plant TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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
});

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ================== ROUTES ==================
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ------------------ AUTH ------------------
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password, plant } = SignUpSchema.parse(req.body);

    const exists = await pool.query("SELECT id FROM public.users WHERE email=$1", [email]);
    if (exists.rows.length) return res.status(409).json({ error: "Email already used" });

    const password_hash = await bcrypt.hash(password, 10);

    const r = await pool.query(
      `INSERT INTO public.users (name, email, password_hash, plant)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, email, plant`,
      [name, email.toLowerCase(), password_hash, plant]
    );

    const user = r.rows[0];
    const token = signToken({ id: user.id, email: user.email });

    res.json({ token, user });
  } catch (e) {
    res.status(400).json({ error: e.message || "Signup failed" });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  try {
    const { email, password } = SignInSchema.parse(req.body);

    const r = await pool.query(
      `SELECT id, name, email, plant, password_hash
       FROM public.users
       WHERE email=$1`,
      [email.toLowerCase()]
    );

    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const user = { id: u.id, name: u.name, email: u.email, plant: u.plant };

    const token = signToken({ id: user.id, email: user.email, plant: user.plant });

    res.json({ token, user });
  } catch (e) {
    res.status(400).json({ error: e.message || "Signin failed" });
  }
});

// ------------------ LLC CREATE ------------------
app.post("/api/llc", requireAuth, upload.any(), async (req, res) => {
  const client = await pool.connect();
  let generatedAbsPath = "";

  try {
    const llc = LlcSchema.parse(JSON.parse(req.body.llc || "{}"));
    const forcedPlant = req.user.plant;
    const forcedValidator = validatorForPlantExact(llc.plant);
    const distribution_to = distributionToForProductLine(llc.product_line_label);
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
      distribution_to,  
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

    const filename = `LLC_${llcId}_${Date.now()}_${safeName(llc.customer)}.docx`;
    generatedAbsPath = path.join(generatedDirAbs, filename);
    fs.writeFileSync(generatedAbsPath, buffer);

    const generatedRel = relPath(generatedAbsPath);

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
          pm_review_token_expires = NOW() + INTERVAL '7 days',
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

app.post("/api/llc/:id/pm-review/decision", async (req, res) => {
  const llcId = Number(req.params.id);
  const { token, action, reason } = req.body;

  if (!llcId || !token || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  if (action === "approve") {
    const r = await pool.query(
      `
      UPDATE public.llc
      SET pm_decision = 'APPROVED',
          pm_decision_at = NOW(),
          pm_validation_date = NOW()
      WHERE id = $1 AND pm_review_token = $2
      RETURNING *
      `,
      [llcId, token]
    );
    return res.json(r.rows[0]);
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
});

// ------------------ LLC LIST ------------------
app.get("/api/llc", requireAuth, async (req, res) => {
  const status = (req.query.status || "").trim();
  const userPlant = req.user.plant;

  try {
    const params = [];
    const whereParts = [];

    params.push(userPlant);
    whereParts.push(`l.plant = $${params.length}`);

    if (status) {
      params.push(status);

      whereParts.push(`l.status = $${params.length}::text`);
    }

    const where = `WHERE ${whereParts.join(" AND ")}`;

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
    res.json(r.rows);
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
    const chk = await client.query("SELECT pm_decision FROM public.llc WHERE id=$1", [llcId]);
    if (!chk.rowCount) throw new Error("Not found");
    if (chk.rows[0].pm_decision !== "REJECTED") throw new Error("Editable only if REJECTED");

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
          pm_review_token_expires = NOW() + INTERVAL '7 days',
          pm_decision = 'PENDING_FOR_VALIDATION',
          pm_decision_at = NULL,
          pm_reject_reason = NULL,
          pm_validation_date = NULL
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

    const filename = `LLC_${llcId}_${Date.now()}_${safeName(llcDb.customer)}.docx`;
    const generatedAbsPath = path.join(generatedDirAbs, filename);
    fs.writeFileSync(generatedAbsPath, buffer);

    const generatedRel = relPath(generatedAbsPath);

    await client.query(
      `UPDATE public.llc
      SET generated_llc = $1
      WHERE id = $2`,
      [generatedRel, llcId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message || "Update failed" });
  } finally {
    client.release();
  }
});


// ================== START ==================
(async () => {
  try {
    await ensureUsersTable();
    console.log("✅ users table ready");
  } catch (e) {
    console.error("❌ Failed to ensure users table:", e.message);
  }

  app.listen(PORT, () => {
    console.log(`🚀 API running on http://localhost:${PORT}`);
  });
})();
