(() => {
  "use strict";
  const C = window.APP_CONFIG;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");
  function toast(msg, ok = true) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = msg;
    toastEl.style.borderColor = ok ? "rgba(54,211,153,.35)" : "rgba(255,77,77,.35)";
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "-");
  const toScan = (addr) => `${C.BLOCK_EXPLORER}/address/${addr}`;
  const toTx = (h) => `${C.BLOCK_EXPLORER}/tx/${h}`;

  // ---------- State ----------
  let provider = null;
  let signer = null;
  let user = null;

  let core = null;
  let usdt = null;
  let earnings = null;
  let stake365 = null;

  // referral from URL
  let refFromUrl = null;
  let sponsorLockedByUrl = false;

  // countdown
  let countdownTimer = null;
  const countdownMap = new Map(); // key -> {endTs, el}

  // ---------- ABIs ----------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  // CoreV3
  const CORE_ABI = [
    "function USDT() view returns (address)",
    "function THBC() view returns (address)",
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 dailyBP,uint256 lockSeconds,uint8 rank)",
    "function buy(uint256 pkgId,address sponsor,uint8 side)",
    "function userStakeCount(address u) view returns (uint256)",
    "function userStakeIndexAt(address u,uint256 i) view returns (uint256)",
    "function defaultSponsor() view returns (address)"
  ];

  // EarningsV2
  const EARNINGS_ABI = [
    "function core() view returns (address)",
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function withdrawableEarnings(address) view returns (uint256)",
    "function claimReferral(uint256 amount)",
    "function claimMatching(uint256 amount)"
  ];

  // Stake365
  const STAKE365_ABI = [
    "function stakes(address,uint256) view returns (uint256 principal,uint256 dailyBP,uint256 startTs,uint256 endTs,uint256 totalReward,bool claimed)",
    "function claim(uint256 index)"
  ];

  // ---------- Utils ----------
  function isAddr(a) {
    try { return ethers.isAddress(a); } catch { return false; }
  }

  function fmtUnits(x, dec = 18, dp = 4) {
    try {
      const s = ethers.formatUnits(x, dec);
      const [i, f = ""] = s.split(".");
      return f ? `${i}.${f.slice(0, dp)}` : i;
    } catch { return "-"; }
  }

  function rankName(r) {
    if (r === 1) return "Bronze";
    if (r === 2) return "Silver";
    if (r === 3) return "Gold";
    return "None";
  }

  async function safeChainId() {
    // ใช้ eth_chainId เสถียรกว่า getNetwork() ใน wallet มือถือ
    const hex = await provider.send("eth_chainId", []);
    return parseInt(hex, 16);
  }

  async function trySwitchToBSC() {
    // พยายามสลับ chain ให้เอง (ถ้า wallet รองรับ)
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: C.CHAIN_ID_HEX }]);
      return true;
    } catch (e) {
      // ถ้า wallet ยังไม่มี chain นี้ → add chain
      const code = e?.code;
      const msg = String(e?.message || "");
      const needAdd = code === 4902 || msg.toLowerCase().includes("unrecognized") || msg.toLowerCase().includes("add");
      if (!needAdd) return false;

      try {
        await provider.send("wallet_addEthereumChain", [{
          chainId: C.CHAIN_ID_HEX,
          chainName: C.CHAIN_NAME || "BNB Smart Chain",
          rpcUrls: [C.RPC_URL],
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          blockExplorerUrls: [C.BLOCK_EXPLORER]
        }]);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function ensureBSC({ autoSwitch = true } = {}) {
    try {
      const cid = await safeChainId();
      if (cid === C.CHAIN_ID_DEC) return true;

      if (autoSwitch) {
        const ok = await trySwitchToBSC();
        if (ok) {
          const cid2 = await safeChainId();
          if (cid2 === C.CHAIN_ID_DEC) return true;
        }
      }

      toast(`กรุณาเปลี่ยนเป็น BNB Chain (chainId ${C.CHAIN_ID_DEC})`, false);
      return false;
    } catch (e) {
      console.error("ensureBSC fail", e);
      toast("เช็ก Network ไม่ได้ (ลองกด Connect ใหม่)", false);
      return false;
    }
  }

  // ---------- Referral helpers ----------
  function readRefFromUrl() {
    try {
      const u = new URL(window.location.href);
      const ref = (u.searchParams.get(C.REF_PARAM || "ref") || "").trim();
      if (ref && isAddr(ref)) return ethers.getAddress(ref);
      return null;
    } catch {
      return null;
    }
  }

  function buildMyRefLink(addr) {
    const u = new URL(window.location.href);
    u.searchParams.set(C.REF_PARAM || "ref", addr);
    // ✅ เพิ่ม side=0 เป็นค่าเริ่มต้น (ถ้าคุณอยากให้มีซ้าย/ขวาในลิงก์)
    // u.searchParams.set("side", "0");
    return u.toString();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function ensureRefUIExists() {
    // สร้าง UI เพิ่มแบบไม่ต้องแก้ index.html
    const leftCard = document.querySelector(".grid .card");
    if (!leftCard) return;
    if ($("myRefBox")) return;

    const hr = document.createElement("div");
    hr.className = "hr";

    const wrap = document.createElement("div");
    wrap.id = "myRefBox";
    wrap.style.marginTop = "6px";
    wrap.innerHTML = `
      <div class="kv">
        <div class="muted">My Referral Link</div>
        <div class="v mono" id="myRefText">-</div>
      </div>
      <div class="smallgrid3" style="margin-top:10px">
        <button class="btn" id="btnCopyRef">Copy Link</button>
        <button class="btn ghost" id="btnCopyAddr">Copy Address</button>
        <a class="btn ghost" id="btnOpenRef" target="_blank" rel="noreferrer">Open</a>
      </div>
      <div class="hr" style="margin-top:14px"></div>
      <div class="kv">
        <div class="muted">Status</div>
        <div class="v mono" id="myStatus">-</div>
      </div>
      <div class="muted" id="needBuyHint" style="margin-top:8px;display:none">
        ถ้าต้องการ “ส่งลิงก์แนะนำ” ให้มีคอมมิชชั่นตามแผน → ต้อง active ก่อน (ซื้อแพ็คเกจ หรือ owner offer ให้พร้อม active)
      </div>
    `;
    leftCard.appendChild(hr);
    leftCard.appendChild(wrap);
  }

  function setRefUIEnabled(enabled) {
    const box = $("myRefBox");
    if (!box) return;
    box.style.opacity = enabled ? "1" : "0.35";
    if ($("btnCopyRef")) $("btnCopyRef").disabled = !enabled;
    if ($("btnCopyAddr")) $("btnCopyAddr").disabled = !enabled;
    if ($("btnOpenRef")) $("btnOpenRef").style.pointerEvents = enabled ? "auto" : "none";
  }

  function parseSideFromUrl() {
    try {
      const u = new URL(window.location.href);
      const s = (u.searchParams.get("side") || "").trim();
      if (s === "0" || s === "1") return Number(s);
      return null;
    } catch {
      return null;
    }
  }

  // ---------- Countdown ----------
  function startCountdownLoop() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [, obj] of countdownMap.entries()) {
        if (!obj.el) continue;
        const diff = obj.endTs - now;
        if (diff <= 0) obj.el.textContent = "READY";
        else {
          const d = Math.floor(diff / 86400);
          const h = Math.floor((diff % 86400) / 3600);
          const m = Math.floor((diff % 3600) / 60);
          const s = diff % 60;
          obj.el.textContent =
            `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
      }
    }, 1000);
  }

  // ---------- Packages ----------
  async function loadPackages() {
    const sel = $("pkg");
    if (!sel) return;
    sel.innerHTML = "";

    let count = 0;
    try {
      count = Number(await core.packageCount());
    } catch (e) {
      console.error("packageCount fail", e);
      toast("อ่าน packageCount ไม่ได้", false);
      return;
    }

    let added = 0;
    for (let i = 0; i < count; i++) {
      try {
        const p = await core.packages(i);
        if (!p.active) continue;

        const opt = document.createElement("option");
        opt.value = String(i);

        const price = fmtUnits(p.usdtPrice, 18, 2);
        const rk = rankName(Number(p.rank));
        opt.textContent = `#${i}  ${price} USDT (${rk})`;

        sel.appendChild(opt);
        added++;
      } catch (e) {
        console.warn("packages(i) fail", i, e);
      }
    }

    if (added === 0) {
      const opt = document.createElement("option");
      opt.value = "0";
      opt.textContent = "#0";
      sel.appendChild(opt);
      toast("ไม่พบ package active (หรืออ่านไม่สำเร็จ)", false);
    }

    await onPkgChange();
  }

  async function onPkgChange() {
    const pkgId = Number($("pkg")?.value || 0);
    try {
      const p = await core.packages(pkgId);
      if ($("price")) $("price").value = fmtUnits(p.usdtPrice, 18, 2);
    } catch {
      if ($("price")) $("price").value = "-";
    }
  }

  // ---------- Refresh ----------
  async function refreshAll() {
    if (!user) return;

    // USDT bal/allow
    try {
      const bal = await usdt.balanceOf(user);
      if ($("usdtBal")) $("usdtBal").textContent = fmtUnits(bal, 18, 4);

      const allow = await usdt.allowance(user, C.CORE);
      if ($("usdtAllow")) $("usdtAllow").textContent = fmtUnits(allow, 18, 4);
    } catch (e) {
      console.error(e);
      if ($("usdtBal")) $("usdtBal").textContent = "-";
      if ($("usdtAllow")) $("usdtAllow").textContent = "-";
    }

    // earnings users(u)
    let rank = 0;
    let active = false;
    let accruedRef = 0n;
    let accruedMatch = 0n;

    try {
      const u = await earnings.users(user);
      rank = Number(u.rank ?? u[0]);
      active = Boolean(u.active ?? u[1]);
      accruedRef = (u.accruedRef ?? u[3]) ?? 0n;
      accruedMatch = (u.accruedMatch ?? u[4]) ?? 0n;

      if ($("myRank")) $("myRank").textContent = rankName(rank);
      if ($("accRef")) $("accRef").textContent = fmtUnits(accruedRef, 18, 4);
      if ($("accMatch")) $("accMatch").textContent = fmtUnits(accruedMatch, 18, 4);

      const w = await earnings.withdrawableEarnings(user);
      if ($("withdrawable")) $("withdrawable").textContent = fmtUnits(w, 18, 4);
    } catch (e) {
      console.error("earnings.users fail", e);
      if ($("myRank")) $("myRank").textContent = "-";
      if ($("accRef")) $("accRef").textContent = "-";
      if ($("accMatch")) $("accMatch").textContent = "-";
      if ($("withdrawable")) $("withdrawable").textContent = "-";
    }

    // Referral UI
    ensureRefUIExists();
    const canShare = rank > 0 && active === true;

    if ($("myStatus")) $("myStatus").textContent = canShare ? "OK_SHARE" : "NEED_ACTIVE";
    if ($("needBuyHint")) $("needBuyHint").style.display = canShare ? "none" : "block";
    setRefUIEnabled(canShare);

    const myRef = buildMyRefLink(user);
    if ($("myRefText")) $("myRefText").textContent = myRef;
    if ($("btnOpenRef")) $("btnOpenRef").href = myRef;

    // stake list
    await loadStakes();

    // claim buttons
    if ($("btnClaimRef")) $("btnClaimRef").disabled = !(accruedRef > 0n);
    if ($("btnClaimMatch")) $("btnClaimMatch").disabled = !(accruedMatch > 0n);
  }

  // ---------- Stakes ----------
  async function loadStakes() {
    const list = $("stakeList");
    if (!list) return;
    list.innerHTML = "";
    countdownMap.clear();

    let n = 0;
    try {
      n = Number(await core.userStakeCount(user));
    } catch (e) {
      console.error("userStakeCount fail", e);
      if ($("stakeCount")) $("stakeCount").textContent = "0";
      return;
    }

    if ($("stakeCount")) $("stakeCount").textContent = String(n);

    for (let i = 0; i < n; i++) {
      let idx = 0n;
      try {
        idx = await core.userStakeIndexAt(user, i);
      } catch (e) {
        console.error("userStakeIndexAt fail", i, e);
        continue;
      }

      const card = document.createElement("div");
      card.className = "item";

      const top = document.createElement("div");
      top.className = "topline";

      const left = document.createElement("div");
      left.innerHTML = `<div class="mono">#${i}  idx: ${idx}</div><div class="tag mono">${short(user)}</div>`;

      const cd = document.createElement("div");
      cd.className = "countdown mono";
      cd.textContent = "-";

      top.appendChild(left);
      top.appendChild(cd);

      const det = document.createElement("div");
      det.style.marginTop = "10px";
      det.className = "smallgrid3";

      const b1 = document.createElement("div");
      b1.className = "pill mono";
      b1.textContent = "principal: -";

      const b2 = document.createElement("div");
      b2.className = "pill mono";
      b2.textContent = "dailyBP: -";

      const b3 = document.createElement("div");
      b3.className = "pill mono";
      b3.textContent = "end: -";

      det.appendChild(b1);
      det.appendChild(b2);
      det.appendChild(b3);

      const actions = document.createElement("div");
      actions.style.marginTop = "10px";
      actions.className = "smallgrid";

      const btnClaim = document.createElement("button");
      btnClaim.className = "btn";
      btnClaim.textContent = "Claim Stake";
      btnClaim.disabled = true;

      const pillState = document.createElement("div");
      pillState.className = "pill mono";
      pillState.textContent = "status: -";

      actions.appendChild(btnClaim);
      actions.appendChild(pillState);

      card.appendChild(top);
      card.appendChild(det);
      card.appendChild(actions);
      list.appendChild(card);

      try {
        const s = await stake365.stakes(user, i);

        const principal = s.principal ?? s[0];
        const dailyBP = s.dailyBP ?? s[1];
        const endTs = Number(s.endTs ?? s[3]);
        const claimed = Boolean(s.claimed ?? s[5]);

        b1.textContent = `principal: ${fmtUnits(principal, 18, 4)}`;
        b2.textContent = `dailyBP: ${Number(dailyBP)}`;
        b3.textContent = `end: ${new Date(endTs * 1000).toLocaleString()}`;

        countdownMap.set(String(idx), { endTs, el: cd });

        const now = Math.floor(Date.now() / 1000);
        if (claimed) {
          pillState.textContent = "status: CLAIMED";
          btnClaim.disabled = true;
        } else if (now >= endTs) {
          pillState.textContent = "status: READY";
          btnClaim.disabled = false;
        } else {
          pillState.textContent = "status: LOCKED";
          btnClaim.disabled = true;
        }

        btnClaim.addEventListener("click", async () => {
          if (!(await ensureBSC({ autoSwitch: true }))) return;
          try {
            btnClaim.disabled = true;
            const tx = await stake365.claim(idx);
            toast("Claim ส่งแล้ว");
            const rc = await tx.wait();
            toast("Claim สำเร็จ");
            console.log("claim tx", toTx(rc.hash));
            await refreshAll();
          } catch (e) {
            console.error(e);
            toast("Claim ไม่สำเร็จ", false);
            btnClaim.disabled = false;
          }
        });
      } catch (e) {
        console.error("stake365.stakes fail", e);
        cd.textContent = "-";
        pillState.textContent = "status: -";
      }
    }

    startCountdownLoop();
  }

  // ---------- Actions ----------
  async function approveUSDT() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC({ autoSwitch: true }))) return;

    const pkgId = Number($("pkg")?.value || 0);
    let need = 0n;
    try {
      const p = await core.packages(pkgId);
      need = p.usdtPrice;
    } catch {
      return toast("อ่านราคาแพ็คเกจไม่ได้", false);
    }

    try {
      $("btnApprove").disabled = true;
      const tx = await usdt.approve(C.CORE, need);
      toast("Approve ส่งแล้ว");
      await tx.wait();
      toast("Approve สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Approve ไม่สำเร็จ", false);
    } finally {
      $("btnApprove").disabled = false;
    }
  }

  async function buyPackage() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC({ autoSwitch: true }))) return;

    const pkgId = Number($("pkg")?.value || 0);

    // side: ถ้า URL มี side=0/1 ให้ตั้งให้เลย (ไม่บังคับ)
    let side = Number($("side")?.value || 0);
    const sideUrl = parseSideFromUrl();
    if (sideUrl !== null && $("side")) {
      $("side").value = String(sideUrl);
      side = sideUrl;
    }

    let sponsor = ($("sponsor")?.value || "").trim();

    if (sponsorLockedByUrl && refFromUrl) sponsor = refFromUrl;

    if (!sponsor || sponsor === "0x") {
      try {
        const ds = await core.defaultSponsor();
        sponsor = (ds && ds !== ethers.ZeroAddress) ? ds : (C.DEFAULT_SPONSOR || ethers.ZeroAddress);
      } catch {
        sponsor = (C.DEFAULT_SPONSOR || ethers.ZeroAddress);
      }
    }

    if (!isAddr(sponsor)) return toast("Sponsor ไม่ถูกต้อง", false);

    try {
      $("btnBuy").disabled = true;
      const tx = await core.buy(pkgId, sponsor, side);
      toast("Buy ส่งแล้ว");
      await tx.wait();
      toast("Buy สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Buy ไม่สำเร็จ", false);
    } finally {
      $("btnBuy").disabled = false;
    }
  }

  async function claimReferral() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC({ autoSwitch: true }))) return;

    try {
      const u = await earnings.users(user);
      const accruedRef = (u.accruedRef ?? u[3]) ?? 0n;
      if (!accruedRef || accruedRef === 0n) return toast("accruedRef = 0", false);

      $("btnClaimRef").disabled = true;
      const tx = await earnings.claimReferral(accruedRef);
      toast("Claim Referral ส่งแล้ว");
      await tx.wait();
      toast("Claim Referral สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Claim Referral ไม่สำเร็จ", false);
    } finally {
      $("btnClaimRef").disabled = false;
    }
  }

  async function claimMatching() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC({ autoSwitch: true }))) return;

    try {
      const u = await earnings.users(user);
      const accruedMatch = (u.accruedMatch ?? u[4]) ?? 0n;
      if (!accruedMatch || accruedMatch === 0n) return toast("accruedMatch = 0", false);

      $("btnClaimMatch").disabled = true;
      const tx = await earnings.claimMatching(accruedMatch);
      toast("Claim Matching ส่งแล้ว");
      await tx.wait();
      toast("Claim Matching สำเร็จ");
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast("Claim Matching ไม่สำเร็จ", false);
    } finally {
      $("btnClaimMatch").disabled = false;
    }
  }

  // ---------- Init Static ----------
  async function initStaticAfterConnect() {
    if ($("coreText")) $("coreText").textContent = short(C.CORE);
    if ($("coreScan")) $("coreScan").href = toScan(C.CORE);

    try {
      const cid = await safeChainId();
      if ($("netPill")) $("netPill").textContent = `chainId: ${cid}`;
    } catch {
      if ($("netPill")) $("netPill").textContent = "-";
    }

    // URL ref
    refFromUrl = readRefFromUrl();

    const sponsorInp = $("sponsor");
    if (sponsorInp) {
      if (refFromUrl) {
        sponsorInp.value = refFromUrl;
        sponsorInp.setAttribute("disabled", "disabled");
        sponsorInp.style.opacity = "0.9";
        sponsorLockedByUrl = true;
        toast("โหลดผู้แนะนำจากลิงก์แล้ว");
      } else {
        sponsorInp.value = (C.DEFAULT_SPONSOR || "").trim();
        sponsorInp.removeAttribute("disabled");
        sponsorLockedByUrl = false;
      }
    }

    // referral box + bind
    ensureRefUIExists();

    const btnCopyRef = $("btnCopyRef");
    const btnCopyAddr = $("btnCopyAddr");

    if (btnCopyRef && !btnCopyRef._bound) {
      btnCopyRef._bound = true;
      btnCopyRef.addEventListener("click", async () => {
        if (!user) return toast("ยังไม่เชื่อมต่อ", false);
        const link = buildMyRefLink(user);
        const ok = await copyText(link);
        toast(ok ? "คัดลอกลิงก์แล้ว" : "คัดลอกไม่สำเร็จ", ok);
      });
    }

    if (btnCopyAddr && !btnCopyAddr._bound) {
      btnCopyAddr._bound = true;
      btnCopyAddr.addEventListener("click", async () => {
        if (!user) return toast("ยังไม่เชื่อมต่อ", false);
        const ok = await copyText(user);
        toast(ok ? "คัดลอก address แล้ว" : "คัดลอกไม่สำเร็จ", ok);
      });
    }
  }

  // ---------- Connect ----------
  async function connect() {
    if (!window.ethereum) return toast("ไม่พบ Wallet", false);

    // ✅ สร้าง provider จาก injected
    provider = new ethers.BrowserProvider(window.ethereum);

    // ✅ ขอ permission ก่อน (มือถือบางตัว chainId จะนิ่งหลัง request)
    await provider.send("eth_requestAccounts", []);

    // ✅ ensure BSC พร้อม auto switch
    if (!(await ensureBSC({ autoSwitch: true }))) return;

    signer = await provider.getSigner();
    user = await signer.getAddress();

    if ($("wallet")) $("wallet").textContent = short(user);
    if ($("walletScan")) $("walletScan").href = toScan(user);

    core = new ethers.Contract(C.CORE, CORE_ABI, signer);
    usdt = new ethers.Contract(C.USDT, ERC20_ABI, signer);
    earnings = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, signer);
    stake365 = new ethers.Contract(C.STAKE365, STAKE365_ABI, signer);

    if ($("btnConnect")) $("btnConnect").disabled = true;

    await initStaticAfterConnect();
    await loadPackages();
    await refreshAll();

    window.ethereum.on?.("accountsChanged", () => window.location.reload());
    window.ethereum.on?.("chainChanged", () => window.location.reload());

    toast("เชื่อมต่อแล้ว");
  }

  // ---------- Bind ----------
  function bind() {
    $("btnConnect")?.addEventListener("click", connect);
    $("btnApprove")?.addEventListener("click", approveUSDT);
    $("btnBuy")?.addEventListener("click", buyPackage);
    $("btnRefresh")?.addEventListener("click", refreshAll);
    $("btnClaimRef")?.addEventListener("click", claimReferral);
    $("btnClaimMatch")?.addEventListener("click", claimMatching);
    $("pkg")?.addEventListener("change", onPkgChange);
  }

  bind();
})();
