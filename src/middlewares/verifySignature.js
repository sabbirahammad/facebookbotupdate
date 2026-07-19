const crypto = require('crypto');

const verifySignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.APP_SECRET;

  if (!signature) {
    console.warn("No x-hub-signature-256 found on request");
    // Depending on your requirements, you might want to return 401 here
    // return res.sendStatus(401);
    return next(); // Proceeding without validation for development purposes
  }

  const elements = signature.split('=');
  const signatureHash = elements[1];

  // Note: For this to work, req.rawBody must be populated.
  if (!req.rawBody) {
    console.error("rawBody is missing. Cannot verify signature.");
    return next();
  }

  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex');

  if (signatureHash !== expectedHash) {
    console.error("Signature doesn't match.");
    return res.sendStatus(403);
  }

  next();
};

module.exports = verifySignature;
