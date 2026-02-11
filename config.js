// ====== STCEx / CoreV3 + EarningsV2 CONFIG ======
window.APP_CONFIG = {
  // ===== Network =====
  CHAIN_ID_DEC: 56,
  CHAIN_ID_HEX: "0x38",
  CHAIN_NAME: "BNB Smart Chain",
  RPC_URL: "https://bsc-dataseed.binance.org/",
  BLOCK_EXPLORER: "https://bscscan.com",

  // ===== Core (CoreV3) =====
  // 0xF1e4eAD1b7f772AF0eC629f0e2695c78C29E11dE
  CORE: "0xF1e4eAD1b7f772AF0eC629f0e2695c78C29E11dE",

  // ===== Tokens =====
  // USDT (BEP20)
  USDT: "0x55d398326f99059fF775485246999027B3197955",

  // ===== Modules =====
  // EarningsV2
  // 0xf4e58b87909c68a07327ea3c82450D2Db51e6f0C
  EARNINGS: "0xf4e58b87909c68a07327ea3c82450D2Db51e6f0C",

  // Referral / Binary / Stake365 / Vault
  REFERRAL: "0xC9053Afa331Cc4c9edeE3326A8BbC69539c15Cf5",
  BINARY:   "0xCFfbdaD135F10FF4AcC756d2a98AB0f75955eD54",
  STAKE365: "0x575B29195ee74bcdAB538Ab4464BabADA13E24DA",
  VAULT:    "0xF703d77075976c5F4FB9ac264e5351a5D301c425",

  // ===== UI / Logic =====
  // ถ้าไม่ส่ง ref มา → จะไปใช้ core.defaultSponsor()
  DEFAULT_SPONSOR: "0x0000000000000000000000000000000000000000",

  // query string ที่ใช้รับ ref link
  // ตัวอย่าง: ?ref=0xabc... หรือ ?sponsor=0xabc...
  REF_PARAM_KEYS: ["ref", "sponsor", "upline"]
};
