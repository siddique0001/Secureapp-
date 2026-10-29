const admin = require('firebase-admin');
const CryptoJS = require('crypto-js');

// Firebase Admin Initialize (Using Environment Variable)
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    });
  } catch (error) {
    console.error('Firebase Admin Init Error:', error);
  }
}

const db = admin.database();
const SECRET = process.env.ENCRYPTION_SECRET;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

exports.handler = async (event, context) => {
  // CORS Headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

  try {
    let body = {};
    if (event.body) body = JSON.parse(event.body);
    
    // URL Parameters for GET requests
    const params = event.queryStringParameters || {};
    const action = body.action || params.action;

    // ==========================================
    // ACTION: ADMIN LOGIN
    // ==========================================
    if (action === "login") {
      if (body.password === ADMIN_PASS) {
        // In a real app, generate a JWT here. For now, we send a success flag.
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: "secure-token-xyz" }) };
      }
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: "Invalid Password" }) };
    }

    // ==========================================
    // ACTION: CREATE CARD (Admin only)
    // ==========================================
    if (action === "create-card") {
      if (body.token !== "secure-token-xyz") return { statusCode: 403, headers, body: JSON.stringify({ message: "Unauthorized" }) };
      
      const data = body.cardData;
      const newRef = db.ref('premium_cards').push();
      const key = newRef.key;
      
      const customerId = "PM-" + key.slice(-8).toUpperCase();
      const createdAt = new Date().toISOString();
      
      // 12 Months Validity
      const d = new Date(createdAt);
      d.setFullYear(d.getFullYear() + 1);
      const expiryDate = d.toISOString();

      // Create Encrypted QR Token
      const payload = { k: key, c: customerId, n: data.name, s: data.shopName, e: expiryDate };
      const token = "PX1:" + CryptoJS.AES.encrypt(JSON.stringify(payload), SECRET).toString();

      const cardToSave = {
        customerName: data.name,
        customerId,
        shopName: data.shopName,
        mobile: data.mobile,
        email: data.email || "",
        createdAt,
        expiryDate,
        scanCount: 0,
        qrToken: token
      };

      await newRef.set(cardToSave);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, card: cardToSave }) };
    }

    // ==========================================
    // ACTION: GET ALL CARDS (Admin only)
    // ==========================================
    if (action === "get-all-cards") {
      if (params.token !== "secure-token-xyz") return { statusCode: 403, headers, body: JSON.stringify({ message: "Unauthorized" }) };
      
      const snapshot = await db.ref('premium_cards').once('value');
      const cards = [];
      snapshot.forEach(child => cards.push({ _key: child.key, ...child.val() }));
      
      // Sort newest first
      cards.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, cards }) };
    }

    // ==========================================
    // ACTION: GET SINGLE CARD (Public)
    // ==========================================
    if (action === "get-card") {
      const cardId = params.cardId;
      if (!cardId) return { statusCode: 400, headers, body: JSON.stringify({ message: "Missing Card ID" }) };

      const snapshot = await db.ref(`premium_cards/${cardId}`).once('value');
      if (!snapshot.exists()) return { statusCode: 404, headers, body: JSON.stringify({ message: "Card not found" }) };
      
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, card: snapshot.val() }) };
    }

    // ==========================================
    // ACTION: VERIFY QR SCAN
    // ==========================================
    if (action === "scan-qr") {
      const qrText = body.qrText;
      if (!qrText || !qrText.startsWith("PX1:")) return { statusCode: 400, headers, body: JSON.stringify({ message: "Invalid QR" }) };

      try {
        const decrypted = CryptoJS.AES.decrypt(qrText.slice(4), SECRET).toString(CryptoJS.enc.Utf8);
        const payload = JSON.parse(decrypted);
        
        const cardRef = db.ref(`premium_cards/${payload.k}`);
        const snap = await cardRef.once('value');
        if (!snap.exists()) return { statusCode: 404, headers, body: JSON.stringify({ message: "Card not found in DB" }) };
        
        const card = snap.val();
        if (card.customerId !== payload.c) return { statusCode: 400, headers, body: JSON.stringify({ message: "QR Integrity Failed" }) };

        // Increment scan count securely on backend
        await cardRef.child('scanCount').transaction((current) => (current || 0) + 1);
        
        // Fetch fresh data
        const freshSnap = await cardRef.once('value');
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, card: freshSnap.val() }) };
        
      } catch (err) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: "Decryption failed" }) };
      }
    }

    return { statusCode: 404, headers, body: JSON.stringify({ message: "Action not found" }) };

  } catch (error) {
    console.error("Server Error:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ message: "Internal Server Error" }) };
  }
};
