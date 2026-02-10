(() => {
  "use strict";

  const C = window.APP_CONFIG;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");

  function toast(msg, ok = true) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.borderColor = ok
      ? "rgba(54,211,153,.35)"
      : "rgba(255,77,77,.35)";
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

  // countdown
  let countdownTimer = null;
  const countdownMap = new Map(); // idx -> {endTs, el}

  // ---------- ABIs (minimal) ----------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ];

  const CORE_ABI = [
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 dailyBP,uint256 lockSeconds,uint8 rank)",
    "function buy(uint256 pkgId,address sponsor,uint8 side)",
    "function userStakeCount(address u) view returns (uint256)",
    "function userStakeIndexAt(address u,uint256 i) view returns (uint256)",
  ];

  // NOTE: ใช้เฉพาะฟังก์ชันที่มีจริงใน ABI ที่คุณส่ง (users, claimReferral, claimMatching)
  const EARNINGS_ABI = [
    "function users(address) view returns (uint8 rank,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function claimReferral(uint256 amount)",
    "function claimMatching(uint256 amount)",
    "function claimAll()",
  ];

  // ✅ สำคัญ: stakes(user, index) / claim(index)
  const STAKE365_ABI = [
    "function stakes(address,uint256) view returns (uint256 principal,uint256 dailyBP,uint256 startTs,uint256 endTs,uint256 totalReward,bool claimed)",
    "function claim(uint256 index)",
  ];

  // ---------- Utils ----------
  function fmtCompact18(x, dp = 4) {
    try {
      const s = ethers.formatUnits(x, 18);
      const [i, f = ""] = s.split(".");
      return f ? `${i}.${f.slice(0, dp)}` : i;
    } catch {
      return "-";
    }
  }

  function rankName(r) {
    if (r === 1) return "Bronze";
    if (r === 2) return "Silver";
    if (r === 3) return "Gold";
    return "None";
  }

  async function ensureBSC() {
    const net = await provider.getNetwork();
    if (Number(net.chainId) === C.CHAIN_ID_DEC) return true;

    // พยายามสลับ chain ให้อัตโนมัติ (ถ้ากระเป๋ารองรับ)
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: C.CHAIN_ID_HEX }]);
      return true;
    } catch {
      toast("กรุณาเปลี่ยนเป็น BNB Smart Chain", false);
      return false;
    }
  }

  // ---------- Referral helpers ----------
  function getQueryAddr(key) {
    try {
      const u = new URL(window.location.href);
      const v = (u.searchParams.get(key) || "").trim();
      if (!v || !v.startsWith("0x") || v.length !== 42) return "";
      return v;
    } catch {
      return "";
    }
  }

  function buildRefLink(side) {
    const u = new URL(window.location.href);
    u.searchParams.set("ref", user);
    u.searchParams.set("side", String(side)); // 0=Left,1=Right
    return u.toString();
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      toast("คัดลอกแล้ว");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("คัดลอกแล้ว");
    }
  }

  function setReferralUI(isActive) {
    const refBox = $("refBox");
    const needBox = $("needBuyBox");

    if (isActive) {
      if ($("myStatus")) $("myStatus").textContent = "ACTIVE";
      if (refBox) refBox.style.display = "";
      if (needBox) needBox.style.display = "none";

      const left = buildRefLink(0);
      const right = buildRefLink(1);

      if ($("refLeft")) $("refLeft").textContent = left;
      if ($("refRight")) $("refRight").textContent = right;

      const bL = $("btnCopyLeft");
      const bR = $("btnCopyRight");
      if (bL) bL.onclick = () => copyText(left);
      if (bR) bR.onclick = () => copyText(right);
    } else {
      if ($("myStatus")) $("myStatus").textContent = "NEED_BUY";
      if (refBox) refBox.style.display = "none";
      if (needBox) needBox.style.display = "";
      if ($("needBuyText"))
        $("needBuyText").textContent = "ต้องซื้อแพ็กเกจก่อน จึงจะสมัคร/ส่งลิงก์แนะนำได้";
    }
  }

  // ---------- Countdown ----------
  function startCountdownLoop() {
    if (countdownTimer) clearInterval(countdownTimer);

    countdownTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [, obj] of countdownMap.entries()) {
        if (!obj?.el) continue;
        const diff = obj.endTs - now;

        if (diff <= 0) {
          obj.el.textContent = "READY";
        } else {
          const d = Math.floor(diff / 86400);
          const h = Math.floor((diff % 86400) / 3600);
          const m = Math.floor((diff % 3600) / 60);
          const s = diff % 60;
          obj.el.textContent = `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(
            2,
            "0"
          )}:${String(s).padStart(2, "0")}`;
        }
      }
    }, 1000);
  }

  // ---------- Static init ----------
  async function initStatic() {
    if ($("coreText")) $("coreText").textContent = short(C.CORE);
    if ($("coreScan")) $("coreScan").href = toScan(C.CORE);

    try {
      const net = await provider.getNetwork();
      if ($("netPill")) $("netPill").textContent = `chainId: ${net.chainId}`;
    } catch {
      if ($("netPill")) $("netPill").textContent = "-";
    }

    // ค่าเริ่มต้น sponsor
    if ($("sponsor")) $("sponsor").value = (C.DEFAULT_SPONSOR || "").trim();

    // sponsor จากลิงก์ (ถ้ามี) + ล็อกช่อง
    const refFromUrl = getQueryAddr("ref");
    if (refFromUrl && user && refFromUrl.toLowerCase() !== user.toLowerCase()) {
      $("sponsor").value = refFromUrl;
      $("sponsor").disabled = true;
    } else {
      $("sponsor").disabled = false;
    }

    // side จากลิงก์ (0/1)
    try {
      const u2 = new URL(window.location.href);
      const s = u2.searchParams.get("side");
      if (s === "0" || s === "1") $("side").value = s;
    } catch {}
  }

  // ---------- Packages ----------
  async function loadPackages() {
    const sel = $("pkg");
    sel.innerHTML = "";

    const count = Number(await core.packageCount());
    for (let i = 0; i < count; i++) {
      const p = await core.packages(i);
      if (!p.active) continue;

      const opt = document.createElement("option");
      opt.value = String(i);

      const price = fmtCompact18(p.usdtPrice, 2);
      const rank = rankName(Number(p.rank));
      const daily = Number(p.dailyBP); // 50=0.5%/day, 150=1.5%/day
      opt.textContent = `#${i}  ${price} USDT  | ${rank} | dailyBP ${daily}`;
      sel.appendChild(opt);
    }

    await onPkgChange();
  }

  async function onPkgChange() {
    const pkgId = Number($("pkg").value || 0);
    const p = await core.packages(pkgId);
    if ($("price")) $("price").value = fmtCompact18(p.usdtPrice, 2);
  }

  // ---------- Refresh (balances/earnings/stakes) ----------
  async function refreshAll() {
    if (!user) return;

    // USDT balance / allowance
    const bal = await usdt.balanceOf(user);
    if ($("usdtBal")) $("usdtBal").textContent = fmtCompact18(bal, 4);

    const allow = await usdt.allowance(user, C.CORE);
    if ($("usdtAllow")) $("usdtAllow").textContent = fmtCompact18(allow, 4);

    // earnings users
    let r = 0;
    let accruedRef = 0n;
    let accruedMatch = 0n;

    try {
      const u = await earnings.users(user);
      r = Number(u.rank ?? u[0]);
      accruedRef = (u.accruedRef ?? u[2]) || 0n;
      accruedMatch = (u.accruedMatch ?? u[3]) || 0n;

      if ($("myRank")) $("myRank").textContent = rankName(r);
      if ($("accRef")) $("accRef").textContent = fmtCompact18(accruedRef, 4);
      if ($("accMatch")) $("accMatch").textContent = fmtCompact18(accruedMatch, 4);

      // ถอน/เคลมได้ = accruedRef + accruedMatch (ของจริงในสัญญา ณ ตอนนี้)
      const w = accruedRef + accruedMatch;
      if ($("withdrawable")) $("withdrawable").textContent = fmtCompact18(w, 4);
    } catch (e) {
      console.error(e);
      if ($("myRank")) $("myRank").textContent = "-";
      if ($("accRef")) $("accRef").textContent = "-";
      if ($("accMatch")) $("accMatch").textContent = "-";
      if ($("withdrawable")) $("withdrawable").textContent = "-";
    }

    // ✅ ต้องซื้อก่อนถึงส่งลิงก์
    setReferralUI(r > 0);

    await loadStakes();
  }

  // ---------- Stakes list ----------
  async function loadStakes() {
    const list = $("stakeList");
    if (!list) return;

    list.innerHTML = "";
    countdownMap.clear();

    let n = 0;
    try {
      n = Number(await core.userStakeCount(user));
    } catch {
      if ($("stakeCount")) $("stakeCount").textContent = "0";
      return;
    }
    if ($("stakeCount")) $("stakeCount").textContent = String(n);

    for (let i = 0; i < n; i++) {
      const idx = await core.userStakeIndexAt(user, i);

      const card = document.createElement("div");
      card.className = "item";

      const top = document.createElement("div");
      top.className = "topline";

      const left = document.createElement("div");
      left.innerHTML = `<div class="mono">#${i}  idx: ${idx}</div>`;

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

      // ✅ อ่าน stake ด้วย "idx" (ของจริง) ไม่ใช่ i
      try {
        const s = await stake365.stakes(user, idx);

        const principal = s.principal ?? s[0];
        const dailyBP = s.dailyBP ?? s[1];
        const startTs = Number(s.startTs ?? s[2]);
        const endTs = Number(s.endTs ?? s[3]);
        const totalReward = s.totalReward ?? s[4];
        const claimed = Boolean(s.claimed ?? s[5]);

        b1.textContent = `principal: ${fmtCompact18(principal, 4)}  | reward: ${fmtCompact18(
          totalReward,
          4
        )}`;
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
          pillState.textContent = `status: LOCKED (start ${new Date(
            startTs * 1000
          ).toLocaleString()})`;
          btnClaim.disabled = true;
        }

        btnClaim.onclick = async () => {
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
        };
      } catch (e) {
        console.error("stake read fail", e);
        cd.textContent = "-";
        pillState.textContent = "status: -";
        btnClaim.disabled = true;
      }
    }

    startCountdownLoop();
  }

  // ---------- Actions ----------
  async function approveUSDT() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC())) return;

    const pkgId = Number($("pkg").value || 0);
    const p = await core.packages(pkgId);
    const need = p.usdtPrice;

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
    if (!sponsor || sponsor === "0x") sponsor = C.DEFAULT_SPONSOR;

    // กัน allowance ไม่พอ
    const p = await core.packages(pkgId);
    const allow = await usdt.allowance(user, C.CORE);
    if (allow < p.usdtPrice) {
      toast("ต้องกด Approve USDT ก่อน", false);
      return;
    }

    try {
      $("btnBuy").disabled = true;
      const tx = await core.buy(pkgId, sponsor, side);
      toast("Buy ส่งแล้ว");
      const rc = await tx.wait();
      toast("Buy สำเร็จ");
      console.log("buy tx", toTx(rc.hash));
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
      const accruedRef = (u.accruedRef ?? u[2]) || 0n;
      if (accruedRef === 0n) return toast("Referral = 0", false);

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
      const accruedMatch = (u.accruedMatch ?? u[3]) || 0n;
      if (accruedMatch === 0n) return toast("Matching = 0", false);

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

  async function claimAll() {
    if (!user) return toast("ยังไม่เชื่อมต่อ", false);
    if (!(await ensureBSC())) return;

    try {
      const u = await earnings.users(user);
      const accruedRef = (u.accruedRef ?? u[2]) || 0n;
      const accruedMatch = (u.accruedMatch ?? u[3]) || 0n;
      if (accruedRef + accruedMatch === 0n) return toast("ไม่มีให้เคลม", false);

      // ถ้าสัญญารองรับ claimAll()
      const tx = await earnings.claimAll();
      toast("Claim All ส่งแล้ว");
      await tx.wait();
      toast("Claim All สำเร็จ");
      await refreshAll();
    } catch (e) {
      // ถ้า claimAll ไม่มีจริง/ไม่ผ่าน ให้ไม่พังระบบ
      console.error(e);
      toast("Claim All ไม่สำเร็จ", false);
    }
  }

  // ---------- Connect ----------
  async function connect() {
    if (!window.ethereum) return toast("ไม่พบ Wallet", false);

    provider = new ethers.BrowserProvider(window.ethereum);

    if (!(await ensureBSC())) return;

    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    user = await signer.getAddress();

    if ($("wallet")) $("wallet").textContent = short(user);
    if ($("walletScan")) $("walletScan").href = toScan(user);

    core = new ethers.Contract(C.CORE, CORE_ABI, signer);
    usdt = new ethers.Contract(C.USDT, ERC20_ABI, signer);
    earnings = new ethers.Contract(C.EARNINGS, EARNINGS_ABI, signer);
    stake365 = new ethers.Contract(C.STAKE365, STAKE365_ABI, signer);

    if ($("btnConnect")) $("btnConnect").disabled = true;

    await initStatic();
    await loadPackages();
    await refreshAll();

    // listeners
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

    // ถ้าคุณมีปุ่ม claimAll ในอนาคต
    $("btnClaimAll")?.addEventListener("click", claimAll);
  }

  bind();
})();
