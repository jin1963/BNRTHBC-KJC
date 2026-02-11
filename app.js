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
  let sideFromUrl = null;      // 0/1
  let sponsorLockedByUrl = false;
  let sideLockedByUrl = false;

  // countdown
  let countdownTimer = null;
  const countdownMap = new Map(); // key -> {endTs, el}

  // ---------- ABIs ----------
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  const CORE_ABI = [
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 dailyBP,uint256 lockSeconds,uint8 rank)",
    "function buy(uint256 pkgId,address sponsor,uint8 side)",
    "function userStakeCount(address u) view returns (uint256)",
    "function userStakeIndexAt(address u,uint256 i) view returns (uint256)",
    "function defaultSponsor() view returns (address)"
  ];

  const EARNINGS_ABI = [
    "function users(address) view returns (uint8 rank,bool active,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function withdrawableEarnings(address) view returns (uint256)",
    "function claimReferral(uint256 amount)",
    "function claimMatching(uint256 amount)"
  ];

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

  // ✅ เช็กเชนแบบทน Bitget/หลายกระเป๋า (ใช้ eth_chainId ตรงๆ)
  async function ensureBSC() {
    try {
      const hex = await provider.send("eth_chainId", []);
      const cid = Number.parseInt(hex, 16);
      if (cid === C.CHAIN_ID_DEC) return true;
      toast(`กรุณาเปลี่ยนเป็น BNB Chain (chainId ${C.CHAIN_ID_DEC})`, false);
      return false;
    } catch (e) {
      console.error("ensureBSC fail", e);
      toast("ตรวจสอบเครือข่ายไม่สำเร็จ", false);
      return false;
    }
  }

  // ---------- Referral helpers (REF + SIDE) ----------
  function readRefFromUrl() {
    try {
      const u = new URL(window.location.href);
      const ref = (u.searchParams.get(C.REF_PARAM || "ref") || "").trim();
      if (ref && isAddr(ref)) return ethers.getAddress(ref);
      return null;
    } catch { return null; }
  }

  function readSideFromUrl() {
    try {
      const u = new URL(window.location.href);
      const s = (u.searchParams.get("side") || "").trim().toUpperCase();
      if (s === "L" || s === "0") return 0;
      if (s === "R" || s === "1") return 1;
      return null;
    } catch { return null; }
  }

  function buildMyRefLink(addr, side /*0/1*/) {
    const u = new URL(window.location.href);
    u.searchParams.set(C.REF_PARAM || "ref", addr);
    u.searchParams.set("side", side === 1 ? "R" : "L");
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
      } catch { return false; }
    }
  }

  function ensureRefUIExists() {
    // สร้าง UI เพิ่มแบบไม่ต้องแก้ index.html
    const leftCard = document.querySelector(".grid .card") || document.querySelector(".card");
    if (!leftCard) return;

    if ($("myRefBox")) return;

    const wrap = document.createElement("div");
    wrap.id = "myRefBox";
    wrap.style.marginTop = "14px";

    wrap.innerHTML = `
      <div class="hr"></div>

      <div class="kv">
        <div class="muted">My Referral Link</div>
        <div class="v mono" id="myRefText">-</div>
      </div>

      <div class="smallgrid3" style="margin-top:10px">
        <button class="btn" id="btnCopyLeft">Copy LEFT</button>
        <button class="btn" id="btnCopyRight">Copy RIGHT</button>
        <button class="btn ghost" id="btnCopyAddr">Copy Address</button>
      </div>

      <div class="smallgrid" style="margin-top:10px">
        <a class="btn ghost" id="btnOpenRef" target="_blank" rel="noreferrer">Open</a>
        <div class="pill mono" id="myStatus">-</div>
      </div>

      <div class="muted" id="needBuyHint" style="margin-top:10px;display:none">
        ถ้า Status = NEED_BUY แปลว่ายัง “ส่งลิงก์แนะนำ” ตามแผนไม่ได้ (ต้องซื้อแพ็คเกจ หรือ owner ต้องให้ rank+active)
      </div>
    `;

    leftCard.appendChild(wrap);
  }

  function setRefUIEnabled(enabled) {
    const box = $("myRefBox");
    if (!box) return;
    box.style.opacity = enabled ? "1" : "0.35";
    $("btnCopyLeft").disabled = !enabled;
    $("btnCopyRight").disabled = !enabled;
    $("btnCopyAddr").disabled = !enabled;
    $("btnOpenRef").style.pointerEvents = enabled ? "auto" : "none";
  }

  function bindRefButtons() {
    const bL = $("btnCopyLeft");
    const bR = $("btnCopyRight");
    const bA = $("btnCopyAddr");
    const bO = $("btnOpenRef");

    if (bL && !bL._bound) {
      bL._bound = true;
      bL.addEventListener("click", async () => {
        if (!user) return toast("ยังไม่เชื่อมต่อ", false);
        const link = buildMyRefLink(user, 0);
        const ok = await copyText(link);
        toast(ok ? "คัดลอกลิงก์ LEFT แล้ว" : "คัดลอกไม่สำเร็จ", ok);
        if (bO) bO.href = link;
      });
    }

    if (bR && !bR._bound) {
      bR._bound = true;
      bR.addEventListener("click", async () => {
        if (!user) return toast("ยังไม่เชื่อมต่อ", false);
        const link = buildMyRefLink(user, 1);
        const ok = await copyText(link);
        toast(ok ? "คัดลอกลิงก์ RIGHT แล้ว" : "คัดลอกไม่สำเร็จ", ok);
        if (bO) bO.href = link;
      });
    }

    if (bA && !bA._bound) {
      bA._bound = true;
      bA.addEventListener("click", async () => {
        if (!user) return toast("ยังไม่เชื่อมต่อ", false);
        const ok = await copyText(user);
        toast(ok ? "คัดลอก address แล้ว" : "คัดลอกไม่สำเร็จ", ok);
      });
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
          obj.el.textContent = `${d}d ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
        }
      }
    }, 1000);
  }

  // ---------- Packages ----------
  async function loadPackages() {
    const sel = $("pkg");
    sel.innerHTML = "";

    let count = 0;
    try { count = Number(await core.packageCount()); }
    catch (e) { console.error(e); toast("อ่าน packageCount ไม่ได้", false); return; }

    let added = 0;
    for (let i = 0; i < count; i++) {
      try {
        const p = await core.packages(i);
        if (!p.active) continue;

        const opt = document.createElement("option");
        opt.value = String(i);

        const price = fmtUnits(p.usdtPrice, 18, 2);
        opt.textContent = `#${i}  ${price} USDT (${rankName(Number(p.rank))})`;

        sel.appendChild(opt);
        added++;
      } catch (e) {
        console.warn("packages fail", i, e);
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
    const pkgId = Number($("pkg").value || 0);
    try {
      const p = await core.packages(pkgId);
      $("price").value = fmtUnits(p.usdtPrice, 18, 2);
    } catch {
      $("price").value = "-";
    }
  }

  // ---------- Refresh ----------
  async function refreshAll() {
    if (!user) return;

    // USDT
    try {
      const bal = await usdt.balanceOf(user);
      $("usdtBal").textContent = fmtUnits(bal, 18, 4);
      const allow = await usdt.allowance(user, C.CORE);
      $("usdtAllow").textContent = fmtUnits(allow, 18, 4);
    } catch (e) {
      console.error(e);
      $("usdtBal").textContent = "-";
      $("usdtAllow").textContent = "-";
    }

    // Earnings
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

      $("myRank").textContent = rankName(rank);
      $("accRef").textContent = fmtUnits(accruedRef, 18, 4);
      $("accMatch").textContent = fmtUnits(accruedMatch, 18, 4);

      const w = await earnings.withdrawableEarnings(user);
      $("withdrawable").textContent = fmtUnits(w, 18, 4);
    } catch (e) {
      console.error("earnings.users fail", e);
      $("myRank").textContent = "-";
      $("accRef").textContent = "-";
      $("accMatch").textContent = "-";
      $("withdrawable").textContent = "-";
    }

    // Referral UI
    ensureRefUIExists();
    bindRefButtons();

    const canShare = (rank > 0 && active === true);
    setRefUIEnabled(canShare);

    const st = $("myStatus");
    const hint = $("needBuyHint");
    if (st) st.textContent = canShare ? "OK_SHARE" : "NEED_BUY";
    if (hint) hint.style.display = canShare ? "none" : "block";

    // show link preview (ตาม side ที่เลือกใน dropdown)
    const sideSel = $("side");
    const curSide = Number(sideSel?.value || 0);
    const link = buildMyRefLink(user, curSide);
    if ($("myRefText")) $("myRefText").textContent = link;
    if ($("btnOpenRef")) $("btnOpenRef").href = link;

    // Stakes
    await loadStakes();

    $("btnClaimRef").disabled = !(accruedRef > 0n);
    $("btnClaimMatch").disabled = !(accruedMatch > 0n);
  }

  // ---------- Stakes ----------
  async function loadStakes() {
    const list = $("stakeList");
    list.innerHTML = "";
    countdownMap.clear();

    let n = 0;
    try { n = Number(await core.userStakeCount(user)); }
    catch (e) { console.error(e); $("stakeCount").textContent = "0"; return; }

    $("stakeCount").textContent = String(n);

    for (let i = 0; i < n; i++) {
      let idx = 0n;
      try { idx = await core.userStakeIndexAt(user, i); }
      catch (e) { console.error(e); continue; }

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

      const b1 = document.createElement("div"); b1.className = "pill mono"; b1.textContent = "principal: -";
      const b2 = document.createElement("div"); b2.className = "pill mono"; b2.textContent = "dailyBP: -";
      const b3 = document.createElement("div"); b3.className = "pill mono"; b3.textContent = "end: -";

      det.appendChild(b1); det.appendChild(b2); det.appendChild(b3);

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
        if (claimed) { pillState.textContent = "status: CLAIMED"; btnClaim.disabled = true; }
        else if (now >= endTs) { pillState.textContent = "status: READY"; btnClaim.disabled = false; }
        else { pillState.textContent = "status: LOCKED"; btnClaim.disabled = true; }

        btnClaim.addEventListener("click", async () => {
          if (!(await ensureBSC())) return;
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
        console.error("stake read fail", e);
      }
    }

    startCountdownLoop();
  }

  // ---------- Actions ----------
  async function approveUSDT() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC())) return;

    const pkgId = Number($("pkg").value || 0);

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
    if (!(await ensureBSC())) return;

    const pkgId = Number($("pkg").value || 0);
    const side = Number($("side").value || 0);

    let sponsor = ($("sponsor").value || "").trim();
    if (sponsorLockedByUrl && refFromUrl) sponsor = refFromUrl;

    if (!sponsor || sponsor === "0x") {
      try {
        const ds = await core.defaultSponsor();
        sponsor = (ds && ds !== ethers.ZeroAddress) ? ds : C.DEFAULT_SPONSOR;
      } catch {
        sponsor = C.DEFAULT_SPONSOR;
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
    if (!(await ensureBSC())) return;

    try {
      const u = await earnings.users(user);
      const accruedRef = (u.accruedRef ?? u[3]) ?? 0n;
      if (accruedRef === 0n) return toast("accruedRef = 0", false);

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
    if (!(await ensureBSC())) return;

    try {
      const u = await earnings.users(user);
      const accruedMatch = (u.accruedMatch ?? u[4]) ?? 0n;
      if (accruedMatch === 0n) return toast("accruedMatch = 0", false);

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

  // ---------- Connect ----------
  async function connect() {
    if (!window.ethereum) return toast("ไม่พบ Wallet", false);

    provider = new ethers.BrowserProvider(window.ethereum);

    // ขอ account ก่อน แล้วค่อยเช็ก chain อีกที (บาง wallet getNetwork เพี้ยนถ้ายังไม่ authorize)
    await provider.send("eth_requestAccounts", []);
    if (!(await ensureBSC())) return;

    signer = await provider.getSigner();
    user = await signer.getAddress();

    $("wallet").textContent = short(user);
    $("walletScan").href = toScan(user);

    core = new ethers.Contract(C.CORE, CORE_ABI, signer);
    usdt = new ethers.Contract(C.USDT, ERC20_ABI, signer);
    earnings = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, signer);
    stake365 = new ethers.Contract(C.STAKE365, STAKE365_ABI, signer);

    $("btnConnect").disabled = true;

    await initStatic();
    await loadPackages();
    await refreshAll();

    window.ethereum.on?.("accountsChanged", () => window.location.reload());
    window.ethereum.on?.("chainChanged", () => window.location.reload());

    toast("เชื่อมต่อแล้ว");
  }

  async function initStatic() {
    $("coreText").textContent = short(C.CORE);
    $("coreScan").href = toScan(C.CORE);

    // net pill (อ้าง chainId จาก eth_chainId)
    try {
      const hex = await provider.send("eth_chainId", []);
      const cid = Number.parseInt(hex, 16);
      $("netPill").textContent = `chainId: ${cid}`;
    } catch {
      $("netPill").textContent = "-";
    }

    // read ref + side from URL
    refFromUrl = readRefFromUrl();
    sideFromUrl = readSideFromUrl();

    const sponsorInp = $("sponsor");
    const sideSel = $("side");

    if (refFromUrl) {
      sponsorInp.value = refFromUrl;
      sponsorInp.setAttribute("disabled", "disabled");
      sponsorLockedByUrl = true;
      toast("โหลดผู้แนะนำจากลิงก์แล้ว");
    } else {
      sponsorInp.value = (C.DEFAULT_SPONSOR || "").trim();
      sponsorInp.removeAttribute("disabled");
      sponsorLockedByUrl = false;
    }

    if (sideFromUrl !== null && sideSel) {
      sideSel.value = String(sideFromUrl);
      sideSel.setAttribute("disabled", "disabled");
      sideLockedByUrl = true;
    } else if (sideSel) {
      sideSel.removeAttribute("disabled");
      sideLockedByUrl = false;
    }

    ensureRefUIExists();
    bindRefButtons();

    // อัปเดต preview link ทันที
    if (user && $("myRefText")) {
      const curSide = Number(($("side")?.value || 0));
      $("myRefText").textContent = buildMyRefLink(user, curSide);
    }
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

    // ✅ เปลี่ยน Side แล้วให้เปลี่ยน preview link ด้วย
    $("side")?.addEventListener("change", () => {
      if (!user) return;
      const curSide = Number(($("side")?.value || 0));
      const link = buildMyRefLink(user, curSide);
      if ($("myRefText")) $("myRefText").textContent = link;
      if ($("btnOpenRef")) $("btnOpenRef").href = link;
    });
  }

  bind();
})();
