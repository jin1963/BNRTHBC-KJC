(() => {
  "use strict";
  const C = window.APP_CONFIG;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");
  function toast(msg, ok = true) {
    toastEl.textContent = msg;
    toastEl.style.borderColor = ok ? "rgba(54,211,153,.35)" : "rgba(255,77,77,.35)";
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  const short = (a) => a ? (a.slice(0, 6) + "..." + a.slice(-4)) : "-";
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

  let countdownTimer = null;
  const countdownMap = new Map(); // key -> {endTs, el}

  // ---------- ABIs (minimal) ----------
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
  ];

  const CORE_ABI = [
    "function USDT() view returns (address)",
    "function packageCount() view returns (uint256)",
    "function packages(uint256) view returns (bool active,uint256 usdtPrice,uint256 thbcAmount,uint256 dailyBP,uint256 lockSeconds,uint8 rank)",
    "function buy(uint256 pkgId,address sponsor,uint8 side)",
    "function userStakeCount(address u) view returns (uint256)",
    "function userStakeIndexAt(address u,uint256 i) view returns (uint256)"
  ];

  const EARNINGS_ABI = [
    "function core() view returns (address)",
    "function users(address) view returns (uint8 rank,uint256 paidTotal,uint256 accruedRef,uint256 accruedMatch,uint256 claimedTotal)",
    "function withdrawableEarnings(address) view returns (uint256)",
    "function claimReferral(uint256 amount)",
    "function claimMatching(uint256 amount)"
  ];

  // ✅ Stake365 ABI ตามที่คุณส่งมา (สำคัญ: stakes(user, i) คืน startTs/endTs)
  const STAKE365_ABI = [
    "function stakes(address,uint256) view returns (uint256 principal,uint256 dailyBP,uint256 startTs,uint256 endTs,uint256 totalReward,bool claimed)",
    "function claim(uint256 index)"
  ];

  // ---------- Utils ----------
  function fmtCompact18(x, dp = 4) {
    try {
      const s = ethers.formatUnits(x, 18);
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

  async function ensureBSC() {
    const net = await provider.getNetwork();
    if (Number(net.chainId) === C.CHAIN_ID_DEC) return true;
    toast("กรุณาเปลี่ยนเป็น BNB Chain", false);
    return false;
  }

  // ---------- Countdown ----------
  function startCountdownLoop() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [, obj] of countdownMap.entries()) {
        const diff = obj.endTs - now;
        if (!obj.el) continue;
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

  // ---------- Load Packages ----------
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
      opt.textContent = `#${i}  ${price} USDT  (${rankName(Number(p.rank))})`;
      sel.appendChild(opt);
    }
    await onPkgChange();
  }

  async function onPkgChange() {
    const pkgId = Number($("pkg").value || 0);
    const p = await core.packages(pkgId);
    $("price").value = fmtCompact18(p.usdtPrice, 2);
  }

  // ---------- Balances / Allowance / Earnings ----------
  async function refreshAll() {
    if (!user) return;

    const bal = await usdt.balanceOf(user);
    $("usdtBal").textContent = fmtCompact18(bal, 4);

    const allow = await usdt.allowance(user, C.CORE);
    $("usdtAllow").textContent = fmtCompact18(allow, 4);

    try {
      const u = await earnings.users(user);
      const r = Number(u.rank ?? u[0]);
      const accruedRef = u.accruedRef ?? u[2];
      const accruedMatch = u.accruedMatch ?? u[3];

      $("myRank").textContent = rankName(r);
      $("accRef").textContent = fmtCompact18(accruedRef, 4);
      $("accMatch").textContent = fmtCompact18(accruedMatch, 4);

      const w = await earnings.withdrawableEarnings(user);
      $("withdrawable").textContent = fmtCompact18(w, 4);
    } catch {
      $("myRank").textContent = "-";
      $("accRef").textContent = "-";
      $("accMatch").textContent = "-";
      $("withdrawable").textContent = "-";
    }

    await loadStakes();
  }

  // ---------- Stake List + Countdown + Claim ----------
  async function loadStakes() {
    const list = $("stakeList");
    list.innerHTML = "";
    countdownMap.clear();

    let n = 0;
    try {
      n = Number(await core.userStakeCount(user));
    } catch {
      $("stakeCount").textContent = "0";
      return;
    }
    $("stakeCount").textContent = String(n);

    for (let i = 0; i < n; i++) {
      const idx = await core.userStakeIndexAt(user, i);

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

      // ✅ อ่าน stake จาก stake365.stakes(user, i) (ตาม ABI ที่ส่งมา)
      try {
        const s = await stake365.stakes(user, i);

        const principal = s.principal ?? s[0];
        const dailyBP = s.dailyBP ?? s[1];
        const startTs = Number(s.startTs ?? s[2]);
        const endTs = Number(s.endTs ?? s[3]);
        const totalReward = s.totalReward ?? s[4];
        const claimed = Boolean(s.claimed ?? s[5]);

        b1.textContent = `principal: ${fmtCompact18(principal, 4)}`;
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

        // ปุ่ม claim ใช้ index เดียวกับ core ส่งกลับมา (idx)
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
      const accruedRef = u.accruedRef ?? u[2];
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
    if (!(await ensureBSC())) return;

    try {
      const u = await earnings.users(user);
      const accruedMatch = u.accruedMatch ?? u[3];
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

  // ---------- Connect ----------
  async function connect() {
    if (!window.ethereum) return toast("ไม่พบ Wallet", false);

    provider = new ethers.BrowserProvider(window.ethereum);
    const ok = await ensureBSC();
    if (!ok) return;

    await provider.send("eth_requestAccounts", []);
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

    try {
      const net = await provider.getNetwork();
      $("netPill").textContent = `chainId: ${net.chainId}`;
    } catch {
      $("netPill").textContent = "-";
    }

    $("sponsor").value = (C.DEFAULT_SPONSOR || "").trim();
  }

  // ---------- Bind ----------
  function bind() {
    $("btnConnect").addEventListener("click", connect);
    $("btnApprove").addEventListener("click", approveUSDT);
    $("btnBuy").addEventListener("click", buyPackage);
    $("btnRefresh").addEventListener("click", refreshAll);
    $("btnClaimRef").addEventListener("click", claimReferral);
    $("btnClaimMatch").addEventListener("click", claimMatching);
    $("pkg").addEventListener("change", onPkgChange);
  }

  bind();
})();
