// Envío de mails. Elige el servicio según las variables que estén cargadas en Railway:
//   1) RESEND_API_KEY  -> Resend (recomendado; necesita un dominio propio verificado)
//   2) BREVO_API_KEY   -> Brevo (por API, no usa el puerto SMTP que Railway bloquea)
//   3) SMTP_HOST ...   -> SMTP clásico (Gmail, etc.; en Railway suele estar bloqueado)
// En todos los casos se usa MAIL_REMITENTE (el mail "desde") y MAIL_NOMBRE (el nombre que se ve).

const nodemailer = require("nodemailer");

let transporte = null;

function obtenerTransporte() {
  if (!transporte) {
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      family: 4,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporte;
}

function datosRemitente() {
  const email = process.env.MAIL_REMITENTE || process.env.SMTP_FROM || process.env.SMTP_USER;
  const nombre = (process.env.MAIL_NOMBRE || "Control de accesos").replace(/[<>"\r\n]/g, "");
  return { email, nombre };
}

async function postJSON(url, headers, cuerpo, etiqueta) {
  const respuesta = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", accept: "application/json" }, headers),
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(15000),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(etiqueta + " " + respuesta.status + ": " + detalle);
  }
}

async function enviarEmail(destinatario, asunto, texto) {
  const { email, nombre } = datosRemitente();

  if (process.env.RESEND_API_KEY) {
    if (!email) throw new Error("Falta MAIL_REMITENTE");
    await postJSON(
      "https://api.resend.com/emails",
      { Authorization: "Bearer " + process.env.RESEND_API_KEY },
      { from: nombre + " <" + email + ">", to: [destinatario], subject: asunto, text: texto },
      "Resend"
    );
    return;
  }

  if (process.env.BREVO_API_KEY) {
    if (!email) throw new Error("Falta MAIL_REMITENTE");
    await postJSON(
      "https://api.brevo.com/v3/smtp/email",
      { "api-key": process.env.BREVO_API_KEY },
      { sender: { name: nombre, email: email }, to: [{ email: destinatario }], subject: asunto, textContent: texto },
      "Brevo"
    );
    return;
  }

  if (!process.env.SMTP_HOST) {
    throw new Error("No hay ningún servicio de correo configurado (falta RESEND_API_KEY, BREVO_API_KEY o SMTP_HOST).");
  }
  await obtenerTransporte().sendMail({
    from: nombre + " <" + email + ">",
    to: destinatario,
    subject: asunto,
    text: texto,
  });
}

module.exports = { enviarEmail };
