require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const SITE_API_KEY = process.env.SITE_API_KEY || "";

/* ------------------------------------------------------------------
   Basit dosya tabanlı depo (data/*.json) — Ticaret Paneli ile aynı yaklaşım
------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  } catch (e) {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// products: { [sku]: { name, category, price, stock } }
let products = loadJSON("products.json", null);
if (!products) {
  products = {
    "MB-1042": { name: "Yumuşak Kapanış Menteşe", category: "mobilya", price: 38, stock: 200 },
    "MB-2210": { name: "Tam Boy Çekmece Rayı 45cm", category: "mobilya", price: 96, stock: 150 },
    "MB-3305": { name: "Alüminyum Çekme Kulp", category: "mobilya", price: 44, stock: 300 },
    "MB-4108": { name: "Ayarlanabilir Mobilya Ayağı", category: "mobilya", price: 22, stock: 400 },
    "MB-5012": { name: "Gizli Bağlantı Elemanı (Kam Kilit)", category: "mobilya", price: 14, stock: 500 },
    "MB-6088": { name: "Cam Kapak Menteşesi", category: "mobilya", price: 52, stock: 180 },
    "HR-1077": { name: "Ahşap Vidası Seti (200 adet)", category: "hirdavat", price: 65, stock: 220 },
    "HR-2201": { name: "Darbeli Matkap 650W", category: "hirdavat", price: 1450, stock: 40 },
    "HR-3315": { name: "Silindir Kilit Göbeği", category: "hirdavat", price: 210, stock: 90 },
    "HR-4090": { name: "Plastik Dübel 8mm (100 adet)", category: "hirdavat", price: 29, stock: 350 },
    "HR-5044": { name: "Yağlamalı Menteşe Aparatı", category: "hirdavat", price: 33, stock: 160 },
    "HR-6132": { name: "Su Terazisi 60cm", category: "hirdavat", price: 180, stock: 75 },
  };
  saveJSON("products.json", products);
}

let orders = loadJSON("orders.json", []);
let orderSeq = loadJSON("order-seq.json", { next: 1001 });

function persistProducts() { saveJSON("products.json", products); }
function persistOrders() { saveJSON("orders.json", orders); }
function persistSeq() { saveJSON("order-seq.json", orderSeq); }

/* ------------------------------------------------------------------
   Panel <-> Site kimlik doğrulama (basit API anahtarı)
------------------------------------------------------------------ */
function requireApiKey(req, res, next) {
  if (!SITE_API_KEY) return res.status(500).json({ ok: false, error: "SITE_API_KEY sunucuda tanımlı değil." });
  if (req.headers["x-api-key"] !== SITE_API_KEY) return res.status(401).json({ ok: false, error: "Geçersiz API anahtarı." });
  next();
}

/* ------------------------------------------------------------------
   Herkese açık: ürün kataloğu ve satın alma (vitrin bu uçları kullanır)
------------------------------------------------------------------ */
app.get("/api/public/products", (req, res) => {
  res.json({
    products: Object.entries(products).map(([sku, p]) => ({ sku, ...p })),
  });
});

app.post("/api/checkout", (req, res) => {
  const { name, address, phone, city, items } = req.body || {};
  if (!name || !address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "Ad, adres ve en az bir ürün gerekli." });
  }

  // Stok kontrolü + düşme
  for (const it of items) {
    const p = products[it.sku];
    if (!p) return res.status(400).json({ ok: false, error: `Bilinmeyen ürün kodu: ${it.sku}` });
    if (p.stock < it.qty) return res.status(400).json({ ok: false, error: `${p.name} için yeterli stok yok.` });
  }
  let amount = 0;
  const lines = items.map((it) => {
    const p = products[it.sku];
    p.stock -= it.qty;
    amount += p.price * it.qty;
    return { barcode: it.sku, quantity: it.qty, name: p.name };
  });
  persistProducts();

  const orderNumber = String(orderSeq.next++);
  persistSeq();
  const order = {
    orderNumber,
    customer: name,
    address,
    phone: phone || "",
    city: city || "",
    lines,
    amount,
    status: "Yeni",
    date: new Date().toISOString(),
  };
  orders.push(order);
  persistOrders();

  res.json({ ok: true, orderNumber });
});

/* ------------------------------------------------------------------
   Panel için: sipariş çekme + stok okuma/yazma (x-api-key ile korumalı)
   Ticaret Paneli server.js içindeki fetchOrders/pushStock/fetchStock
   fonksiyonlarının beklediği şekillerle birebir uyumludur.
------------------------------------------------------------------ */
app.get("/api/orders", requireApiKey, (req, res) => {
  // Panel her seferinde son N günü çeker, zaten işlenmiş paketleri kendi
  // processedPackages setiyle eler — burada tekrar filtrelemeye gerek yok.
  const since = Date.now() - 1000 * 60 * 60 * 24 * 14; // son 14 gün
  const recent = orders.filter((o) => new Date(o.date).getTime() >= since);
  res.json({ orders: recent });
});

app.get("/api/stock", requireApiKey, (req, res) => {
  res.json({
    rows: Object.entries(products).map(([sku, p]) => ({ barcode: sku, stock: p.stock, name: p.name, price: p.price })),
  });
});

app.post("/api/stock", requireApiKey, (req, res) => {
  const { barcode, quantity } = req.body || {};
  const sku = String(barcode || "").trim();
  if (!sku || !products[sku]) {
    // Bu ürün bu sitede satılmıyor — hata değil, sadece uygulanamaz.
    return res.json({ ok: true, skipped: true, message: "Bu ürün sitede yok, atlandı." });
  }
  products[sku].stock = Math.max(0, Math.floor(Number(quantity) || 0));
  persistProducts();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Site backend çalışıyor: http://localhost:${PORT}`);
});
