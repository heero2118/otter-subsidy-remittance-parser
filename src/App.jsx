import { useState, useCallback, useRef, useEffect } from "react";

// ─── BRAND ───────────────────────────────────────────────────────────────────
const OL = {
  orange:   "#DB6B30",
  burgundy: "#5B3427",
  sand:     "#E7CEB5",
  gold:     "#E0A526",
  stone:    "#7E6A5D",
  gray:     "#D7D2CB",
  white:    "#FFFFFF",
};

// ─── PROGRAM METADATA ────────────────────────────────────────────────────────
const PROGRAMS = [
  { id: "CAPS",       label: "CAPS",      state: "GA", icon: "🍑", color: OL.gold,     accepts: [".csv"],  hint: ".csv" },
  { id: "FL SR",     label: "FL SR",     state: "FL", icon: "🌴", color: OL.orange,   accepts: [".xlsx"], hint: ".xlsx" },
  { id: "FL VPK",    label: "FL VPK",    state: "FL", icon: "🌴", color: "#1A7A4A",   accepts: [".xlsx"], hint: ".xlsx" },
  { id: "KY CCAP",    label: "KY CCAP",   state: "KY", icon: "🏇", color: OL.burgundy, accepts: [".pdf"],  hint: ".pdf" },
  { id: "PFCC",       label: "PFCC",      state: "OH", icon: "🌻", color: OL.stone,    accepts: [".csv"],  hint: ".csv" },
  { id: "SC ABC",     label: "SC ABC",    state: "SC", icon: "🌊", color: "#4A7C59",   accepts: [".pdf"],  hint: ".pdf" },
];
const PROGRAM_MAP  = Object.fromEntries(PROGRAMS.map(p => [p.id, p]));
const EXPECTED_EXT = Object.fromEntries(PROGRAMS.map(p => [p.id, p.accepts]));

// ─── MONEY HELPERS ────────────────────────────────────────────────────────────
// Parse a money string like "$1,234.56" or "-782" or "1234" → number
function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  return isNaN(n) ? 0 : n;
}
function round2(n) { return Math.round(n * 100) / 100; }

// ─── CHECK TOTAL LOGIC ────────────────────────────────────────────────────────
// Each parser returns { rows, statedTotal }.
// statedTotal: the net total as stated in the document (null = no total in file).
// After parsing, we compute parsedTotal = sum of net_payment for all non-rejected rows,
// then stamp each row with check_total.
//
// "Net total" definition per program:
//   SC ABC  : Remittance Advice Total  (paid CS + reg fees + adjustments, excludes rejected)
//   KY CCAP : Total Net Payment        (= Amount Payable - Recouped)
//   CAPS    : Pay Amount               (header-level)
//   FL VPK  : Grand Total Net Amt      (last row of xlsx)
//   PFCC    : no stated total → check_total = "" for all rows

function stampCheckTotal(rows, statedTotal) {
  // statedTotal null/undefined → no check possible
  if (statedTotal === null || statedTotal === undefined) {
    return rows.map(r => ({ ...r, check_total: "" }));
  }

  // Sum net contributions: paid CS rows → net_payment, RF rows → registration_fee,
  // Adjustment rows → recoupment_amount (negative), Rejected rows → excluded.
  const parsedTotal = round2(rows.reduce((sum, r) => {
    const status = (r.status || "").toLowerCase();
    if (status === "rejected") return sum;                     // excluded from total
    if (status === "registration fee") return sum + toNum(r.registration_fee);
    if (status === "adjustment")       return sum + toNum(r.recoupment_amount); // negative
    // paid / default
    return sum + toNum(r.net_payment);
  }, 0));

  const stated  = round2(toNum(statedTotal));
  const diff    = round2(parsedTotal - stated);
  const ok      = Math.abs(diff) < 0.02; // tolerance for floating-point

  const label = ok
    ? "✓ OK"
    : `⚠ MISMATCH (stated $${stated.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}, parsed $${parsedTotal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}, diff $${diff.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})})`;

  return rows.map(r => ({ ...r, check_total: label }));
}

// ─── SERVICE PERIOD SPLITTER ─────────────────────────────────────────────────
function splitServicePeriod(raw) {
  if (!raw || !raw.trim()) return { start: "", end: "" };
  const s = raw.trim();
  const fullRange = s.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s*[-\u2013]\s*(\d{1,2}\/\d{1,2}\/\d{4})$/);
  if (fullRange) return { start: fullRange[1], end: fullRange[2] };
  const compact = s.match(/^(\d{1,2}\/\d{1,2})-(\d{1,2}\/\d{1,2}\/\d{4})$/);
  if (compact) { const year = compact[2].split("/")[2]; return { start: `${compact[1]}/${year}`, end: compact[2] }; }
  const monthYear = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) { const [, mo, yr] = monthYear; const lastDay = new Date(parseInt(yr), parseInt(mo), 0).getDate(); return { start: `${mo}/01/${yr}`, end: `${mo}/${lastDay}/${yr}` }; }
  if (s.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) return { start: s, end: "" };
  return { start: s, end: "" };
}
function withSP(row) {
  const { start, end } = splitServicePeriod(row.service_period);
  return { ...row, service_period_start: start, service_period_end: end };
}

// ─── PARSERS ─────────────────────────────────────────────────────────────────
// Each returns { rows: [...], statedTotal: number|null }

function parseCAPSCsv(text, fileName) {
  const lines = text.split(/\r?\n/);
  const meta = {};
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("Remittance Number,")) meta.remittance_number = l.split(",")[1]?.trim();
    if (l.startsWith("Pay Amount,"))         meta.pay_amount        = l.split(",")[1]?.trim();
    if (l.startsWith("Number of Invoices,")) meta.num_invoices      = l.split(",")[1]?.trim();
    if (l.startsWith("Recoupment Amount,"))  meta.recoupment_amount = l.split(",")[1]?.trim();
    if (l.startsWith("Legal Name,"))         meta.legal_name        = l.split(",").slice(1).join(",").trim();
    if (l.startsWith("Business Name,"))      meta.business_name     = l.split(",").slice(1).join(",").trim();
    if (l.startsWith("Payment Date,"))       meta.payment_date      = l.split(",")[1]?.trim();
    if (l.startsWith("Child Name,"))         { headerIdx = i; break; }
  }
  // Stated total = Pay Amount (header-level net after recoupment)
  // CAPS "Net Payment" per row = what gets paid out per row (already net of family fee)
  // The doc-level Pay Amount = sum of all row Net Payment values
  const statedTotal = meta.pay_amount ? toNum(meta.pay_amount) : null;

  const rows = [];
  if (headerIdx >= 0) {
    const headers = parseCsvLine(lines[headerIdx]);
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const vals = parseCsvLine(lines[i]);
      if (vals.length < headers.length) continue;
      const row = {};
      headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] || "").trim(); });
      rows.push(withSP({
        source_file: fileName, program_type: "CAPS", state: "GA",
        company_name: meta.legal_name || meta.business_name || "",
        school_name:  meta.business_name || meta.legal_name || "",
        remittance_number: meta.remittance_number || "",
        payer_name:   "",
        payment_date: row["Payment Date"] || meta.payment_date || "",
        pay_date:     row["Payment Date"] || meta.payment_date || "",
        process_date: meta.payment_date || "",
        child_name:   row["Child Name"] || "",
        service_period: row["Service Week"] || "",
        invoice_number: row["Invoice Number"] || "",
        status:         row["Status"] || "",
        gateway_scholarship_number: row["Gateway Scholarship Number"] || "",
        sf_scholarship_number:      row["SF Scholarship number"] || "",
        type_of_care:  row["Type of Care"] || "",
        parent_weekly_responsibility: row["Parents Weekly Responsibility"] || "",
        registration_fee: row["Registration fee"] || "",
        base_rate:     row["Base Rate"] || "",
        family_fee:    row["Family Fee"] || "",
        differential:  row["Differential"] || "",
        authorized_payment: row["Authorized Payment"] || "",
        recoupment_amount:  row["Recoupment Amount"] || "",
        net_payment:   row["Net Payment"] || "",
        days_paid: "", daily_rate: "", gross_amount: "", copay: "", care_level: "",
        child_id: "", dob: "", voucher_number: "", case_number: "", issuance_id: "",
        adjustment_code: "", county: "", site_id: "", rate_type: "",
      }));
    }
  }
  return { rows, statedTotal };
}

function parsePFCCCsv(text, fileName) {
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] || "").trim(); });
    const spStart = row["Service Period Start"] || "";
    const spEnd   = row["Service Period End"]   || "";
    const sp = spStart && spEnd ? `${spStart} - ${spEnd}` : spStart || spEnd;
    rows.push(withSP({
      source_file: fileName, program_type: "PFCC", state: "OH",
      company_name: row["Provider Name"] || "", school_name: row["Provider Name"] || "",
      payer_name: "", remittance_number: "", payment_date: row["Payment Date"] || "", pay_date: row["Payment Date"] || "", process_date: row["Payment Date"] || "",
      child_name: row["Child Name"] || "", service_period: sp,
      invoice_number: row["Invoice"] || "", status: "",
      gateway_scholarship_number: "", sf_scholarship_number: "", type_of_care: "",
      parent_weekly_responsibility: "", registration_fee: "", base_rate: "",
      family_fee: row["Family Fee"] || "", differential: "", authorized_payment: "", recoupment_amount: "",
      net_payment: row["Invoice"] || "",
      days_paid: "", daily_rate: "", gross_amount: "", copay: "", care_level: "",
      child_id: "", dob: "", voucher_number: "",
      case_number: row["Case Number"] || "", issuance_id: row["Issuance ID"] || "",
      adjustment_code: row["Adjustment Code"] || "", county: "", site_id: "", rate_type: "",
    }));
  }
  return { rows, statedTotal: null }; // PFCC has no stated total line
}

// ─── KY CCAP PARSER (spatial word-level) ─────────────────────────────────────
// Anchors on care-level codes (PS-1, TD-2, IN-1, etc.) as the reliable fixed
// token per row, reads fixed offsets outward for dates/days/rates/amounts,
// and handles wrapped names by post-fixing orphan tokens onto the preceding row.
// Validated: 57 rows, $42,362 total match on KY_CCAP.pdf.

function kyCareLevel(s) { return /^(PS|TD|IN|TO|TW|SA|SF)-\d$/.test(s); }
function kyDateCompact(s) { return /^\d{2}\/\d{2}-\d{2}\/\d{2}\/\d{4}$/.test(s); }
function kyDateFull(s)    { return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s); }

const KY_SKIP = new Set([
  "PAYMENT","DETAILS","Child","Activity","Cabinet","Health","Family","Services",
  "Web","site","Printed","Date:","REMITTANCE","REPORT","COMMONWEALTH","DCC-97",
  "922","KAR","2:160","CHFS,","DCBS","Division","For","Care","at","Site:","County:",
  "North","Charleston,","South","Carolina","EAV","NOTES","Note","Date","Page",
  "Otter","Learning","KY","LLC","Rivers","Ave","Ste","Pmb","East","Main","Street",
  "Frankfort,","An","Equal","Opportunity","Employer","M/F/D","http://chfs.ky.gov/",
]);

async function parseKYCCAPWords(wordsByPage, fileName) {
  const rows = [];
  let siteName    = "";
  let companyName = "Otter Learning KY LLC";
  let county      = "";
  let statedTotal = null;
  let lastChildName  = "";
  let nameIncomplete = false;   // last recorded row has surname-only child name

  for (let pn = 0; pn < wordsByPage.length; pn++) {
    const pageRows = groupWordsIntoRows(wordsByPage[pn]);

    // Skip EAV NOTES pages
    const hdr4 = pageRows.slice(0, 4).map(r => r.join(" ")).join(" ");
    if (hdr4.includes("EAV") && hdr4.includes("NOTES")) continue;

    // Metadata
    for (const r of pageRows) {
      const j = r.join(" ");
      const sm = j.match(/For Care at Site:\s*(.+)/);
      if (sm) siteName = sm[1].trim();
      const cm = j.match(/County:\s*(\w+)/);
      if (cm) county = cm[1];
    }

    // Stated total — sum across all "Total Net Payment $X" rows (multiple batches)
    for (const r of pageRows) {
      if (r[0] === "Total" && r[1] === "Net" && r[2] === "Payment" && r[3]) {
        statedTotal = (statedTotal || 0) + toNum(r[3]);
      }
    }

    // Parse data rows
    for (let ri = 0; ri < pageRows.length; ri++) {
      const r = pageRows[ri];
      const j = r.join(" ");

      // Skip header/metadata rows
      if (r.some(t => KY_SKIP.has(t) && t.length > 2) &&
          !r.some(t => kyDateCompact(t) || kyCareLevel(t))) continue;

      const careIdx = r.findIndex(t => kyCareLevel(t));

      if (careIdx < 0) {
        // Orphan row — name continuation or date fragment
        const isNameOrphan = r.length <= 2 && r.every(t => /^[A-Z\'\-\.]+,?$/.test(t));
        if (isNameOrphan && nameIncomplete && rows.length) {
          // Append first name to the truncated surname in the last row
          const orphan = r.join(" ");
          rows[rows.length - 1].child_name =
            rows[rows.length - 1].child_name.replace(/,?\s*$/, "") + ", " + orphan;
          lastChildName  = rows[rows.length - 1].child_name;
          nameIncomplete = false;
        }
        continue;
      }

      const pre  = r.slice(0, careIdx);
      // pdf.js sometimes merges adjacent tokens e.g. "17 FD" or "Provider Rate"
      // Flatten by splitting every token on whitespace to restore individual words
      const post = r.slice(careIdx).flatMap(t => t.split(" ").filter(Boolean));
      // post layout after flatten: [care, days, FD, rate, copay, Provider, Rate, amount]
      const careLevel   = post[0];
      const days        = post[1] || "";
      const stripDollar = v => (v || "").replace(/[$,]/g, "");
      const rate        = stripDollar(post[3]);
      const copay       = stripDollar(post[4]);
      const netAmt      = stripDollar(post[7] || "");

      // Find dates in pre
      const datePairs = pre.map((t, i) => ({ i, t }))
                          .filter(({ t }) => kyDateFull(t) || kyDateCompact(t));
      let payDate = "", period = "";
      if (datePairs.length >= 2) {
        period  = datePairs[datePairs.length - 2].t;
        payDate = datePairs[datePairs.length - 1].t;
      } else if (datePairs.length === 1) {
        period  = kyDateCompact(datePairs[0].t) ? datePairs[0].t : "";
        payDate = kyDateFull(datePairs[0].t)    ? datePairs[0].t : "";
      }

      // Name + activity = tokens before first date
      const firstDateI = datePairs.length ? datePairs[0].i : careIdx;
      let nameAct = pre.slice(0, firstDateI);

      // Strip activity — pdf.js may merge "Enrolled" + date into one token e.g. "Enrolled 8-Jan-2026"
      let activity = "";
      const actI = nameAct.findIndex(t => t.startsWith("Enrolled") || t.startsWith("Discontinued"));
      if (actI >= 0) {
        // Capture just the keyword (Enrolled/Discontinued), drop any appended date
        activity = nameAct[actI].split(/\s+/)[0];
        nameAct  = nameAct.slice(0, actI);
      }

      let childName = nameAct.join(" ").trim().replace(/,\s*$/, "");
      const rawEndsComma = nameAct.join(" ").trim().endsWith(",");
      nameIncomplete = rawEndsComma && nameAct.length <= 2;

      // Fill-down: empty child = continuation row (multi-care-level child)
      if (!childName) {
        childName      = lastChildName;
        nameIncomplete = false;
      } else {
        lastChildName = childName;
      }

      rows.push(withSP({
        source_file:   fileName,    program_type:  "KY CCAP",   state:         "KY",
        payer_name:    "",
        company_name:  companyName, school_name:   siteName,    county,
        process_date:  payDate,     payment_date:  payDate,     pay_date:      payDate,
        child_name:    childName,   service_period: period,     invoice_number: "",
        status:        activity,    care_level:    careLevel,   days_paid:     days,
        base_rate:     rate,        copay,          net_payment: netAmt,
        remittance_number: "", gateway_scholarship_number: "", sf_scholarship_number: "",
        type_of_care: "", parent_weekly_responsibility: "", registration_fee: "",
        family_fee: "", differential: "", authorized_payment: "", recoupment_amount: "",
        daily_rate: rate, gross_amount: netAmt,
        child_id: "", dob: "", voucher_number: "", case_number: "", issuance_id: "",
        adjustment_code: "", site_id: siteName.match(/L(\d+)/)?.[0] || "",
        rate_type: "Provider Rate",
      }));
    }
  }

  return { rows, statedTotal };
}


// ─── SHARED SPATIAL UTILITY ───────────────────────────────────────────────────
// Groups pdf.js word items [{str, x, y}] into visual rows by y-proximity.
// Used by both KY CCAP and SC ABC parsers.
function groupWordsIntoRows(wordItems, yTol = 4) {
  if (!wordItems || !wordItems.length) return [];
  const sorted = [...wordItems].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
  const rows = [];
  let cur = [sorted[0]], curY = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    if (Math.abs(w.y - curY) <= yTol) {
      cur.push(w);
    } else {
      rows.push(cur.sort((a, b) => a.x - b.x).map(w => w.str));
      cur = [w]; curY = w.y;
    }
  }
  if (cur.length) rows.push(cur.sort((a, b) => a.x - b.x).map(w => w.str));
  return rows;
}

// ─── SC ABC PARSER (spatial word-level) ───────────────────────────────────────
// Validated: 8 files, all row counts and stated totals match exactly.

const SC_ABC_COMMON_SURNAMES = new Set([
  "ALLEN","JONES","SMITH","BROWN","WHITE","GREEN","DAVIS","SCOTT","KING","HALL",
  "WARD","FORD","LANE","MOORE","YOUNG","CLARK","LEWIS","HILL","REED","COLE","MYERS",
  "KERR","GOOCH","SLACK","PERRY","CURRY","DEEDS","TAYLOR","RIFFE","ROBINSON","WASHINGTON",
  "WILLIAMS","MONTGOMERY","HOLLINGSWORTH","PRIESTER","MARSHALL","BINYARD","DUPONT","GRAVES",
  "FRAZIER","JENKINS","CAMPBELL","WILSON","COHEN","DONALDSON","PICHAY","PITTS","VISE",
  "WALLACE","WOLFORD","FULTON","HARRIS","HEYWARD","MAJOR","LUJAN","SHINE","CAPERS",
  "BODDEN","ALSTON","AVILA","FONTENOT","HOLMES","HOOVER","KLASSY","ROMERO","ATTLES",
  "BLANE","DOVE","REEVES","SIMMONS","SMALLS","TUCKER","MASIAS","MCZEKE","MEISTER",
  "MIDDLETON","MITCHELL","OTTERSON","PALMER","PASCHALL","PINCKNEY","RAU","GILLIARD",
  "GREENWOOD","GUILLEN","REQUENA","HINTZ","HUTCHINSON","JOYNER","LACERNA","LOJEWSKI",
  "ARBUCKLE","BAILEY","BOWER","COUNCIL","CYNTHIA","DOMINGUE","FRANCO","MAXEY",
  "HAMILTON","TUALA","NEIL","REYNOLDS","ESCALANTE","MCCLAIN","VENNING","EZQUERRA",
  "GUTIERREZ","IMPERIAL","DORE","WYCOVIA",
]);
const SC_ABC_SKIP = new Set([
  "Client","Name","Recip.","#","Voucher","Ser.","Per.","Type","Units","Amount",
  "Service","Stop","Date*","CC1004","FID#",":","OTTER","LEARNING","SC","LLC",
  "Process","Advice","Remittance","Paid","Vouchers","Registration","Fees",
  "Adjustments","Rejected",
]);
const SC_ABC_CHILD_PREFIXES = new Set(["MARLEI","YA","SIR","KA","JAE"]);

function scAbcIsDate(s)    { return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s); }
function scAbcIsRecip(s)   { return /^XXX-XX-\d{4}-\d{2}$/.test(s); }
function scAbcIsVoucher(s) { return /^(TD|G)\d+$/.test(s); }

function scAbcSplitNames(tokens) {
  const toks = tokens.filter(t =>
    !SC_ABC_SKIP.has(t) && !/^\d+$/.test(t) && !t.startsWith("Page")
  );
  if (!toks.length)    return ["", ""];
  if (toks.length === 1) return ["", toks[0]];
  if (toks.length === 2) return [toks[0], toks[1]];
  const last = toks[toks.length - 1];
  const prev = toks[toks.length - 2];
  const isCompound = SC_ABC_CHILD_PREFIXES.has(prev) ||
    (prev.length <= 4 && /^[A-Z\']+$/.test(prev) && !SC_ABC_COMMON_SURNAMES.has(prev));
  if (isCompound) return [toks.slice(0, -2).join(" "), `${prev} ${last}`];
  return [toks.slice(0, -1).join(" "), last];
}

function scAbcParseRow(tokens, section, processDate, siteName, fileName) {
  const ri = tokens.findIndex(t => scAbcIsRecip(t));
  if (ri < 0) return null;
  const after = tokens.slice(ri + 1);
  if (!after.length) return null;
  const voucher = after[0];
  if (!scAbcIsVoucher(voucher)) return null;

  const [parentName, childName] = scAbcSplitNames(tokens.slice(0, ri));
  const rest = after.slice(1);
  const isAdj = voucher.startsWith("G");

  let typeCode, svcPeriod, units, amount, stopDate;

  if (isAdj) {
    typeCode  = rest.find(t => ["CS","RF","GR"].includes(t)) || "CS";
    const ti  = rest.findIndex(t => ["CS","RF","GR"].includes(t));
    svcPeriod = rest[0] && scAbcIsDate(rest[0]) ? rest[0] : "";
    const post = rest.slice(ti + 1);
    units    = post[0] || "1";
    amount   = post[1] || "";
    stopDate = "";
  } else {
    const typeIdx = rest.findIndex(t => ["CS","RF","GR"].includes(t));
    if (typeIdx < 0) return null;
    typeCode  = rest[typeIdx];
    const pre  = rest.slice(0, typeIdx);
    const post = rest.slice(typeIdx + 1);
    svcPeriod = pre[0] && scAbcIsDate(pre[0]) ? pre[0] : "";
    if (post.length < 2) return null;
    units    = post[0];
    amount   = post[1];
    stopDate = post[2] && scAbcIsDate(post[2]) ? post[2] : "";
  }

  const isRF       = section === "Registration Fee";
  const isAdjSec   = section === "Adjustment";

  return withSP({
    source_file:   fileName,      program_type:  "SC ABC",               state:        "SC",
    company_name:  "Otter Learning SC LLC",       school_name:   siteName,
    remittance_number: "",        payment_date:  processDate,            pay_date:     processDate,
    process_date:  processDate,   child_name:    childName,              service_period: svcPeriod,
    invoice_number: "",           status:        section,
    gateway_scholarship_number: "", sf_scholarship_number: "",
    type_of_care:  typeCode,      parent_weekly_responsibility: "",
    registration_fee:   isRF       ? amount : "",
    base_rate: "",  family_fee: "", differential: "", authorized_payment: "",
    recoupment_amount:  isAdjSec   ? amount : "",
    net_payment:        (!isRF && !isAdjSec && section !== "Rejected") ? amount : "",
    days_paid:     "",            daily_rate: "",  gross_amount:  amount,
    copay: "",      care_level: "", child_id: "",   dob: "",
    voucher_number: voucher,      case_number: "", issuance_id: "",
    adjustment_code: isAdjSec ? voucher : "",
    county: "",     site_id: "",  rate_type:     typeCode,
    payer_name:    parentName,    parent_name:   parentName,   recip_number:  tokens[ri],
    service_stop_date: stopDate, section,
    sc_abc_units:  units,
  });
}

async function parseSCABCWords(wordsByPage, fileName) {
  const allRows = [];
  let siteName    = "";
  let processDate = "";
  let statedTotal = null;

  for (let pn = 0; pn < wordsByPage.length; pn++) {
    const pageRows = groupWordsIntoRows(wordsByPage[pn]);

    // Section from page header (first 8 rows)
    let section = "Paid";
    const hdr   = pageRows.slice(0, 8).map(r => r.join(" ")).join(" ");
    if (hdr.includes("Registration Fees"))  section = "Registration Fee";
    else if (hdr.includes("Rejected Vouchers")) section = "Rejected";
    else if (hdr.includes("Adjustments") && !hdr.slice(0, hdr.indexOf("Adjustments")).includes("Total")) section = "Adjustment";

    // Site name (page 1)
    // Row 0 = "OTTER LEARNING SC LLC", row 1 = school name, row 2 = street, row 3 = city
    if (pn === 0 && pageRows.length >= 2) {
      siteName = pageRows[1].join(" ");
    }

    // Process date
    for (const r of pageRows) {
      const m = r.join(" ").match(/Process\s+Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (m) processDate = m[1];
    }

    // Stated total — "Remittance Advice Total:" row, last $X,XXX token
    for (const r of pageRows) {
      if (r[0] === "Remittance" && r[1] === "Advice" && r[2] === "Total:") {
        const dollars = r.filter(t => /^\$[\d,]+$/.test(t));
        if (dollars.length) statedTotal = toNum(dollars[dollars.length - 1]);
      }
    }

    // Parse data rows
    for (const r of pageRows) {
      if (r.includes("Client")) continue;
      if (!r.some(t => scAbcIsRecip(t))) continue;
      const rec = scAbcParseRow(r, section, processDate, siteName, fileName);
      if (rec) allRows.push(rec);
    }
  }

  return { rows: allRows, statedTotal };
}


function parseFLVPKData(rawData, fileName, programId) {
  const rows        = [];
  const programType = programId || "FL SR";
  let processDate   = "";
  let statedTotal   = null;

  // ── Step 1: find the Coalition header row (col A = "Coalition") ──────────────
  let headerRowIdx = -1;
  for (let i = 0; i < rawData.length; i++) {
    const r = rawData[i];
    if (r && String(r[0] || "").trim() === "Coalition") { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) return { rows, statedTotal };

  // ── Step 2: grab Service Period from rows above the header ───────────────────
  for (let i = 0; i < headerRowIdx; i++) {
    const r = rawData[i];
    if (!r) continue;
    const v = String(r[0] || "");
    const m = v.match(/Service Period:\s*(.+)/i);
    if (m) processDate = m[1].trim();
  }

  // ── Step 3: map header columns by name (robust to column shifts) ─────────────
  const hdr = rawData[headerRowIdx];
  const ci  = {}; // col index map
  hdr.forEach((v, i) => {
    if (v == null) return;
    const s = String(v).replace(/\n/g, " ").trim().toLowerCase();
    if (s === "coalition")                           ci.coalition   = i;
    else if (s === "provider")                       ci.provider    = i;
    else if (s.startsWith("child"))                  ci.child       = i;
    else if (s.startsWith("payment"))                ci.payPeriod   = i;
    else if (s.startsWith("unit"))                   ci.careLevel   = i;
    else if (s.startsWith("bg"))                     ci.bgElig      = i;
    else if (s === "type")                           ci.type        = i;
    else if (s.startsWith("days"))                   ci.days        = i;
    else if (s.startsWith("daily rate"))             ci.dailyRate   = i;
    else if (s.startsWith("gross"))                  ci.gross       = i;
    else if (s.includes("copay") || s.includes("co pay")) ci.copay = i;
    else if (s.startsWith("parent amt"))             ci.parentAmt   = i;
    else if (s.startsWith("net"))                    ci.net         = i;
  });

  // ── Step 4: parse data rows ───────────────────────────────────────────────────
  let coalition = "", provider = "";
  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const r = rawData[i];
    if (!r) continue;

    const c0 = String(r[0] || "").trim();

    // Grand Total row
    if (c0 === "Grand Total") {
      const netVal = ci.net != null ? r[ci.net] : null;
      if (netVal != null) statedTotal = toNum(netVal);
      continue;
    }
    // Skip totals / blank rows
    if (/total/i.test(c0) || /total/i.test(String(r[1] || "")) || /total/i.test(String(ci.child != null ? r[ci.child] || "" : ""))) continue;

    // Fill-down coalition and provider
    if (c0 && c0 !== "Coalition") coalition = c0;
    const c1 = String(r[1] || "").trim();
    if (c1 && c1 !== "Provider" && !/total/i.test(c1)) provider = c1;

    // Child cell
    const childRaw = ci.child != null ? r[ci.child] : null;
    if (!childRaw) continue;
    const childStr = String(childRaw).trim();
    if (!childStr || childStr === "Child") continue;

    const childLines = childStr.includes("\n") ? childStr.split("\n") : [childStr];
    const childName  = childLines[0].trim();
    if (!childName) continue;

    const dob        = (childLines.find(l => l.startsWith("DoB:"))       || "").replace("DoB:", "").trim();
    const childId    = (childLines.find(l => l.startsWith("Child ID:"))  || "").replace("Child ID:", "").trim();
    const assessment = (childLines.find(l => l.startsWith("Assessment:"))||"").replace("Assessment:", "").trim();

    const g = (idx) => idx != null && r[idx] != null ? String(r[idx]) : "";
    const sp = g(ci.payPeriod);

    rows.push(withSP({
      source_file:   fileName,       program_type:  programType,       state:        "FL",
      company_name:  "Otter Learning", school_name: provider || coalition,
      payer_name:    "",             remittance_number: "",
      payment_date:  sp,             pay_date:      sp,                process_date: sp,
      child_name:    childName,      service_period: processDate,
      invoice_number: "",            status: "",
      gateway_scholarship_number: "", sf_scholarship_number: "",
      type_of_care:  g(ci.type),     parent_weekly_responsibility: "",
      registration_fee: "",          family_fee: "",                   differential: "",
      authorized_payment: "",        recoupment_amount: "",
      net_payment:   g(ci.net),      days_paid:     g(ci.days),
      daily_rate:    g(ci.dailyRate),gross_amount:  g(ci.gross),
      copay:         g(ci.copay),    care_level:    g(ci.careLevel),
      child_id: childId, dob, base_rate: g(ci.dailyRate),
      voucher_number: "", case_number: "", issuance_id: "", adjustment_code: "",
      county: "", site_id: "", rate_type: g(ci.type),
      bg_elig: g(ci.bgElig), assessment,
      parent_copay_amt: g(ci.parentAmt), coalition,
    }));
  }
  return { rows, statedTotal };
}


// ─── UTILITIES ────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const result = []; let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { result.push(cur); cur = ""; continue; }
    cur += ch;
  }
  result.push(cur); return result;
}
function readFileAsText(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsText(file); }); }
function readFileAsArrayBuffer(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }
let xlsxLoadPromise = null;
function ensureXlsx() {
  if (!xlsxLoadPromise) {
    xlsxLoadPromise = new Promise((resolve, reject) => {
      if (window.XLSX) { resolve(); return; }
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return xlsxLoadPromise;
}
async function parseXlsx(buffer) {
  await ensureXlsx();
  const wb = window.XLSX.read(new Uint8Array(buffer), { type: "array" });
  return window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
}
// Use a promise so concurrent calls await the same load instead of injecting duplicate scripts
let pdfLoadPromise = null;
function ensurePdfJs() {
  if (!pdfLoadPromise) {
    pdfLoadPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(); return; }
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        // Disable the worker — required for sandboxed iframes (CSP blocks worker URLs)
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "";
        resolve();
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return pdfLoadPromise;
}
async function parsePdfText(file) {
  await ensurePdfJs();
  const buf = await readFileAsArrayBuffer(file);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) { const page = await pdf.getPage(i); const tc = await page.getTextContent(); fullText += tc.items.map(it => it.str).join(" ") + "\n"; }
  return fullText;
}

async function parsePdfWords(file) {
  // Returns [{str, x, y}] per page — used by SC ABC spatial parser
  await ensurePdfJs();
  const buf = await readFileAsArrayBuffer(file);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const wordsByPage = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc   = await page.getTextContent();
    const vp   = page.getViewport({ scale: 1 });
    // pdf.js uses bottom-left origin; flip Y so top=0
    const items = tc.items.map(it => ({
      str: it.str.trim(),
      x:   it.transform[4],
      y:   vp.height - it.transform[5],
    })).filter(w => w.str.length > 0);
    wordsByPage.push(items);
  }
  return wordsByPage;
}
function fileExt(name) { return "." + name.split(".").pop().toLowerCase(); }
function toCSV(rows, keys) {
  if (!rows.length) return "";
  const ks     = keys || Object.keys(rows[0]);
  const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [ks.join(","), ...rows.map(r => ks.map(k => escape(r[k])).join(","))].join("\n");
}


// ─── COLUMN CONFIG ────────────────────────────────────────────────────────────
const CORE_COLS = [
  { key: "process_date",         label: "Process Date" },
  { key: "check_total",          label: "Check Total" },
  { key: "program_type",         label: "Program" },
  { key: "state",                label: "State" },
  { key: "school_name",          label: "School / Provider" },
  { key: "company_name",         label: "Company" },
  { key: "child_name",           label: "Child Name" },
  { key: "payer_name",            label: "Payer Name" },
  { key: "service_period_start", label: "Svc Period Start" },
  { key: "service_period_end",   label: "Svc Period End" },
  { key: "care_level",           label: "Care Level" },
  { key: "days_paid",            label: "Days" },
  { key: "daily_rate",           label: "Daily Rate" },
  { key: "gross_amount",         label: "Gross Amt" },
  { key: "copay",                label: "Copay" },
  { key: "net_payment",          label: "Net Payment" },
  { key: "status",               label: "Status" },
  { key: "source_file",          label: "Source File" },
];

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function RemittanceParser() {
  const [rows,          setRows]          = useState([]);
  const [loadingZone,   setLoadingZone]   = useState(null);
  const [errors,        setErrors]        = useState([]);
  const [zoneErrors,    setZoneErrors]    = useState({});  // { programId: [msg, ...] }
  const [search,        setSearch]        = useState("");
  const [filterProgram, setFilterProgram] = useState("ALL");
  const [filterCheck,   setFilterCheck]   = useState("ALL"); // "ALL" | "OK" | "MISMATCH" | "N/A"
  const [showAllCols,   setShowAllCols]   = useState(false);
  const [sortKey,       setSortKey]       = useState("pay_date");
  const [sortDir,       setSortDir]       = useState("desc");
  const [dragOverZone,  setDragOverZone]  = useState(null);
  const [page,          setPage]          = useState(1);
  const PAGE_SIZE = 50;
  const fileInputRefs   = useRef({});

  const processFiles = useCallback(async (files, programId) => {
    setLoadingZone(programId);
    const newRows = [], newErrors = [], newZoneErrs = [];
    for (const file of files) {
      const ext = fileExt(file.name);
      const expected = EXPECTED_EXT[programId] || [];
      if (!expected.includes(ext)) {
        newZoneErrs.push(`"${file.name}" is a ${ext} file — this zone expects ${expected.join(" or ")}`);
        continue;
      }
      try {
        let result;
        if      (programId === "CAPS")      result = parseCAPSCsv(await readFileAsText(file), file.name);
        else if (programId === "PFCC")      result = parsePFCCCsv(await readFileAsText(file), file.name);
        else if (programId === "FL SR" || programId === "FL VPK") result = parseFLVPKData(await parseXlsx(await readFileAsArrayBuffer(file)), file.name, programId);
        else if (programId === "KY CCAP")   result = await parseKYCCAPWords(await parsePdfWords(file), file.name);
        else if (programId === "SC ABC")    result = await parseSCABCWords(await parsePdfWords(file), file.name);
        if (result) {
          const stamped = stampCheckTotal(result.rows, result.statedTotal);
          newRows.push(...stamped);
        }
      } catch (e) { newErrors.push(`${file.name}: ${e.message}`); }
    }
    setRows(prev => [...prev, ...newRows]);
    setErrors(prev => [...prev, ...newErrors]);
    if (newZoneErrs.length > 0) setZoneErrors(prev => ({ ...prev, [programId]: [...(prev[programId] || []), ...newZoneErrs] }));
    setLoadingZone(null);
  }, []);

  // Recursively collect all File objects from a FileSystemEntry tree
  const readEntryFiles = useCallback((entry) => {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(f => resolve([f]), () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const allEntries = [];
        const readBatch = () => {
          reader.readEntries(async (batch) => {
            if (!batch.length) {
              const nested = await Promise.all(allEntries.map(e => readEntryFiles(e)));
              resolve(nested.flat());
            } else {
              allEntries.push(...batch);
              readBatch(); // readEntries only returns up to 100 at a time
            }
          }, () => resolve([]));
        };
        readBatch();
      } else {
        resolve([]);
      }
    });
  }, []);

  const handleDrop = useCallback(async (e, pid) => {
    e.preventDefault();
    setDragOverZone(null);
    const items = Array.from(e.dataTransfer.items || []);
    // Use FileSystem API for folders if available, fall back to .files
    if (items.length && items[0].webkitGetAsEntry) {
      const entries = items.map(i => i.webkitGetAsEntry()).filter(Boolean);
      const allFiles = (await Promise.all(entries.map(readEntryFiles))).flat();
      if (allFiles.length) { processFiles(allFiles, pid); return; }
    }
    processFiles(Array.from(e.dataTransfer.files), pid);
  }, [processFiles, readEntryFiles]);

  const handleFileChange = useCallback((e, pid) => {
    processFiles(Array.from(e.target.files), pid);
    e.target.value = "";
  }, [processFiles]);

  // Refs for both the file picker and folder picker inputs per zone
  const folderInputRefs = useRef({});
  const handleSort       = (key) => { if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortKey(key); setSortDir("asc"); } };

  const filteredRows = rows
    .filter(r => filterProgram === "ALL" || r.program_type === filterProgram)
    .filter(r => {
      if (filterCheck === "ALL") return true;
      const ct = String(r.check_total || "");
      if (filterCheck === "OK")       return ct.startsWith("✓");
      if (filterCheck === "MISMATCH") return ct.startsWith("⚠");
      if (filterCheck === "N/A")      return ct === "";
      return true;
    })
    .filter(r => !search || Object.values(r).some(v => String(v).toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => sortDir === "asc" ? String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? "")) : String(b[sortKey] ?? "").localeCompare(String(a[sortKey] ?? "")));

  const programs  = ["ALL", ...Array.from(new Set(rows.map(r => r.program_type)))];
  const cols      = showAllCols ? Object.keys(rows[0] || {}).map(k => ({ key: k, label: k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) })) : CORE_COLS;
  // Reset to page 1 whenever filters/sort change
  useEffect(() => { setPage(1); }, [search, filterProgram, filterCheck, sortKey, sortDir]);
  const totalPages  = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pagedRows   = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalNet  = filteredRows.reduce((s, r) => { const v = toNum(r.net_payment); return s + (isNaN(v) ? 0 : v); }, 0);
  const progCount = rows.reduce((acc, r) => { acc[r.program_type] = (acc[r.program_type] || 0) + 1; return acc; }, {});
  const mismatchCount = rows.filter(r => String(r.check_total || "").startsWith("⚠")).length;

  return (
    <div style={{ fontFamily: "'Montserrat', Arial, sans-serif", background: OL.sand, minHeight: "100vh", color: OL.burgundy }}>

      {/* Header */}
      <div style={{ background: OL.burgundy, padding: "16px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `4px solid ${OL.orange}` }}>
        <div>
          <div style={{ fontFamily: "'Suez One', Georgia, serif", color: OL.white, fontSize: 22 }}>🦦 Otter Learning — Remittance Parser</div>
          <div style={{ color: OL.sand, fontSize: 12, marginTop: 2 }}>CAPS · FL SR · FL VPK · KY CCAP · PFCC · SC ABC</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <StatChip label="Records"    value={rows.length}          color={OL.orange} />
          <StatChip label="Filtered"   value={filteredRows.length}  color={OL.gold} />
          <StatChip label="Net Total"  value={`$${totalNet.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`} color="#4A7C59" />
          {mismatchCount > 0 && <StatChip label="Mismatches" value={mismatchCount} color="#C0392B" />}
        </div>
      </div>

      <div style={{ padding: "20px 28px" }}>

        {/* Parse errors */}
        {errors.length > 0 && (
          <div style={{ background: "#FFF0EB", border: `1px solid ${OL.orange}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
            {errors.map((e, i) => (
              <div key={i} style={{ color: "#B03A1A", display: "flex", justifyContent: "space-between" }}>
                <span>⚠️ {e}</span>
                <button onClick={() => setErrors(p => p.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: OL.stone }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Per-agency drop zones */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 22 }}>
          {PROGRAMS.map(prog => {
            const isOver = dragOverZone === prog.id, isLoading = loadingZone === prog.id, count = progCount[prog.id] || 0;
            return (
              <div key={prog.id}
                onDrop={e => handleDrop(e, prog.id)}
                onDragOver={e => { e.preventDefault(); setDragOverZone(prog.id); }}
                onDragLeave={() => setDragOverZone(null)}
                style={{ border: `2px dashed ${isOver ? prog.color : (zoneErrors[prog.id]?.length ? "#C0392B" : OL.gray)}`, borderRadius: 12, background: isOver ? `${prog.color}22` : OL.white, padding: "14px 10px", textAlign: "center", transition: "all 0.15s", position: "relative", minHeight: 128, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, boxShadow: isOver ? `0 0 0 3px ${prog.color}55` : "none" }}
              >
                {/* Record count badge */}
                {count > 0 && <div style={{ position: "absolute", top: 8, right: 8, background: prog.color, color: OL.white, borderRadius: 12, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{count}</div>}

                {/* Clickable upload area */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: "100%", cursor: "default" }}>
                  <div style={{ fontSize: 28 }}>{prog.icon}</div>
                  <div style={{ fontFamily: "'Suez One', Georgia, serif", fontSize: 14, color: prog.color }}>{prog.label}</div>
                  <div style={{ fontSize: 10, color: OL.stone }}>{prog.state} · {prog.hint}</div>
                  {isLoading
                    ? <div style={{ fontSize: 11, color: prog.color, fontWeight: 600, marginTop: 2 }}>⏳ Processing…</div>
                    : (
                      <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
                        <button onClick={e => { e.stopPropagation(); fileInputRefs.current[prog.id]?.click(); }}
                          style={{ padding: "3px 10px", background: prog.color, color: OL.white, border: "none", borderRadius: 8, fontSize: 10, cursor: "pointer", fontFamily: "'Montserrat', Arial, sans-serif", fontWeight: 600 }}>
                          📄 Files
                        </button>
                        <button onClick={e => { e.stopPropagation(); folderInputRefs.current[prog.id]?.click(); }}
                          style={{ padding: "3px 10px", background: "none", color: prog.color, border: `1px solid ${prog.color}`, borderRadius: 8, fontSize: 10, cursor: "pointer", fontFamily: "'Montserrat', Arial, sans-serif", fontWeight: 600 }}>
                          📁 Folder
                        </button>
                      </div>
                    )
                  }
                  <div style={{ fontSize: 9, color: OL.gray, marginTop: 1 }}>or drag &amp; drop</div>
                </div>

                {/* Per-zone file type errors */}
                {zoneErrors[prog.id]?.length > 0 && (
                  <div style={{ width: "100%", marginTop: 6 }}>
                    {zoneErrors[prog.id].map((msg, i) => (
                      <div key={i} style={{ background: "#FFF0EB", border: `1px solid #E8A090`, borderRadius: 5, padding: "4px 6px", marginBottom: 3, fontSize: 10, color: "#B03A1A", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 4, textAlign: "left" }}>
                        <span>⚠ {msg}</span>
                        <button onClick={e => { e.stopPropagation(); setZoneErrors(prev => ({ ...prev, [prog.id]: prev[prog.id].filter((_, j) => j !== i) })); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "#B03A1A", fontSize: 13, lineHeight: 1, flexShrink: 0, padding: 0 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Per-agency clear button */}
                {count > 0 && !isLoading && (
                  <button
                    onClick={e => { e.stopPropagation(); setRows(prev => prev.filter(r => r.program_type !== prog.id)); setZoneErrors(prev => ({ ...prev, [prog.id]: [] })); }}
                    style={{ marginTop: 4, padding: "2px 10px", background: "none", border: `1px solid ${OL.gray}`, borderRadius: 10, fontSize: 10, color: OL.stone, cursor: "pointer", fontFamily: "'Montserrat', Arial, sans-serif" }}>
                    clear {prog.label}
                  </button>
                )}

                <input ref={el => fileInputRefs.current[prog.id] = el} type="file" multiple accept={prog.accepts.join(",")} onChange={e => handleFileChange(e, prog.id)} style={{ display: "none" }} />
                <input ref={el => folderInputRefs.current[prog.id] = el} type="file" webkitdirectory="" mozdirectory="" multiple onChange={e => handleFileChange(e, prog.id)} style={{ display: "none" }} />
              </div>
            );
          })}
        </div>

        {rows.length > 0 && (
          <>
            {/* Controls */}
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <input placeholder="🔍  Search all fields…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ flex: "1 1 200px", padding: "8px 12px", border: `1px solid ${OL.gray}`, borderRadius: 7, fontSize: 13, background: OL.white, color: OL.burgundy, outline: "none" }} />
              <select value={filterProgram} onChange={e => setFilterProgram(e.target.value)}
                style={{ padding: "8px 12px", border: `1px solid ${OL.gray}`, borderRadius: 7, fontSize: 13, background: OL.white, color: OL.burgundy, cursor: "pointer" }}>
                {programs.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              {/* Check Total filter */}
              <select value={filterCheck} onChange={e => setFilterCheck(e.target.value)}
                style={{ padding: "8px 12px", border: `1px solid ${mismatchCount > 0 ? "#C0392B" : OL.gray}`, borderRadius: 7, fontSize: 13, background: OL.white, color: mismatchCount > 0 && filterCheck === "ALL" ? "#C0392B" : OL.burgundy, cursor: "pointer", fontWeight: mismatchCount > 0 ? 600 : 400 }}>
                <option value="ALL">All Check Totals</option>
                <option value="OK">✓ OK only</option>
                <option value="MISMATCH">⚠ Mismatches only</option>
                <option value="N/A">No total (N/A)</option>
              </select>
              <button onClick={() => setShowAllCols(v => !v)}
                style={{ padding: "8px 14px", background: showAllCols ? OL.stone : OL.white, color: showAllCols ? OL.white : OL.burgundy, border: `1px solid ${OL.stone}`, borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
                {showAllCols ? "Core Columns" : "All Columns"}
              </button>
              <ExportButton filteredRows={filteredRows} cols={cols} />
              <button onClick={() => { setRows([]); setErrors([]); setZoneErrors({}); }}
                style={{ padding: "8px 14px", background: OL.white, color: OL.stone, border: `1px solid ${OL.gray}`, borderRadius: 7, fontSize: 13, cursor: "pointer" }}>
                Clear All
              </button>
            </div>

            {/* Program badges */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {Object.entries(progCount).map(([prog, cnt]) => {
                const p = PROGRAM_MAP[prog];
                return <div key={prog} style={{ background: p?.color || OL.stone, color: OL.white, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600 }}>{p?.icon} {prog}: {cnt}</div>;
              })}
              {mismatchCount > 0 && (
                <div onClick={() => setFilterCheck(filterCheck === "MISMATCH" ? "ALL" : "MISMATCH")}
                  style={{ background: "#C0392B", color: OL.white, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: filterCheck === "MISMATCH" ? "2px solid #7B241C" : "2px solid transparent" }}>
                  ⚠ {mismatchCount} mismatche{mismatchCount !== 1 ? "s" : ""}
                </div>
              )}
            </div>

            {/* Table */}
            <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${OL.gray}`, background: OL.white }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: OL.burgundy, color: OL.white }}>
                    {cols.map(col => (
                      <th key={col.key} onClick={() => handleSort(col.key)}
                        style={{ padding: "10px 12px", textAlign: "left", whiteSpace: "nowrap", cursor: "pointer", fontFamily: "'Suez One', Georgia, serif", fontWeight: "normal", fontSize: 11, letterSpacing: "0.04em", userSelect: "none" }}>
                        {col.label}{sortKey === col.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row, i) => {
                    const prog = PROGRAM_MAP[row.program_type];
                    const ct   = String(row.check_total || "");
                    const isMiss    = ct.startsWith("⚠");
                    const rowBg  = isMiss ? "#FFF5F5" : i % 2 === 0 ? OL.white : "#FAF6F1";
                    return (
                      <tr key={i} style={{ background: rowBg }}>
                        {cols.map(col => {
                          let cellColor  = OL.burgundy;
                          let cellWeight = 400;
                          let cellTitle  = undefined;
                          if (col.key === "program_type") { cellColor = prog?.color || OL.stone; cellWeight = 700; }
                          if (col.key === "check_total") {
                            cellColor  = ct.startsWith("✓") ? "#1A7A4A" : ct.startsWith("⚠") ? "#C0392B" : OL.stone;
                            cellWeight = ct ? 600 : 400;
                            cellTitle  = ct;
                          }
                          const val     = String(row[col.key] ?? "");
                          const display = col.key === "check_total" && val.length > 22 ? val.slice(0, 22) + "…" : val;
                          return (
                            <td key={col.key} title={cellTitle}
                              style={{ padding: "8px 12px", borderBottom: `1px solid ${OL.gray}`, color: cellColor, fontWeight: cellWeight, whiteSpace: ["child_name","school_name","service_period_start","service_period_end"].includes(col.key) ? "nowrap" : "normal", maxWidth: col.key === "check_total" ? 140 : 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredRows.length === 0 && <div style={{ padding: 30, textAlign: "center", color: OL.stone }}>No records match your filters.</div>}
            </div>
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 12, color: OL.stone }}>
                Showing {Math.min((page - 1) * PAGE_SIZE + 1, filteredRows.length)}–{Math.min(page * PAGE_SIZE, filteredRows.length)} of {filteredRows.length} records
              </div>
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => setPage(1)}         disabled={page === 1}           style={{ padding: "3px 8px", border: `1px solid ${OL.gray}`, borderRadius: 5, background: OL.white, cursor: page===1?"not-allowed":"pointer", color: page===1?OL.gray:OL.burgundy, fontSize: 12 }}>«</button>
                  <button onClick={() => setPage(p => p-1)} disabled={page === 1}           style={{ padding: "3px 8px", border: `1px solid ${OL.gray}`, borderRadius: 5, background: OL.white, cursor: page===1?"not-allowed":"pointer", color: page===1?OL.gray:OL.burgundy, fontSize: 12 }}>‹</button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                    .reduce((acc, p, idx, arr) => {
                      if (idx > 0 && p - arr[idx-1] > 1) acc.push("...");
                      acc.push(p); return acc;
                    }, [])
                    .map((p, i) => p === "..." ? (
                      <span key={`e${i}`} style={{ padding: "3px 4px", fontSize: 12, color: OL.stone }}>…</span>
                    ) : (
                      <button key={p} onClick={() => setPage(p)}
                        style={{ padding: "3px 8px", border: `1px solid ${p===page?OL.burgundy:OL.gray}`, borderRadius: 5, background: p===page?OL.burgundy:OL.white, color: p===page?OL.white:OL.burgundy, cursor: "pointer", fontSize: 12, fontWeight: p===page?600:400, minWidth: 28 }}>
                        {p}
                      </button>
                    ))
                  }
                  <button onClick={() => setPage(p => p+1)} disabled={page===totalPages} style={{ padding: "3px 8px", border: `1px solid ${OL.gray}`, borderRadius: 5, background: OL.white, cursor: page===totalPages?"not-allowed":"pointer", color: page===totalPages?OL.gray:OL.burgundy, fontSize: 12 }}>›</button>
                  <button onClick={() => setPage(totalPages)} disabled={page===totalPages} style={{ padding: "3px 8px", border: `1px solid ${OL.gray}`, borderRadius: 5, background: OL.white, cursor: page===totalPages?"not-allowed":"pointer", color: page===totalPages?OL.gray:OL.burgundy, fontSize: 12 }}>»</button>
                </div>
              )}
            </div>
          </>
        )}

        {rows.length === 0 && loadingZone === null && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: OL.stone }}>
            <div style={{ fontSize: 44, marginBottom: 10 }}>📄</div>
            <div style={{ fontFamily: "'Suez One', Georgia, serif", fontSize: 18, color: OL.burgundy, marginBottom: 6 }}>No files loaded yet</div>
            <div style={{ fontSize: 13 }}>Drop files into their agency zone above, or click any zone to browse.</div>
          </div>
        )}
      </div>

    </div>
  );
}



function ExportButton({ filteredRows, cols }) {
  const [csvUrl, setCsvUrl] = useState(null);
  const [rowCount, setRowCount] = useState(0);

  // Regenerate the download URL whenever filteredRows changes
  useEffect(() => {
    if (!filteredRows.length) { setCsvUrl(null); setRowCount(0); return; }
    const csv  = toCSV(filteredRows, cols ? cols.map(c => c.key) : null);
    // Try Blob URL first, fall back to data URI
    let url;
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      url = URL.createObjectURL(blob);
    } catch(e) {
      url = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    }
    setCsvUrl(url);
    setRowCount(filteredRows.length);
    // Cleanup old blob URLs
    return () => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); };
  }, [filteredRows]);

  if (!csvUrl) {
    return (
      <button disabled style={{ padding: "8px 16px", background: OL.gray, color: OL.white, border: "none", borderRadius: 7, fontSize: 13, cursor: "not-allowed", fontWeight: 600 }}>
        ⬇ Export CSV
      </button>
    );
  }

  return (
    <a href={csvUrl} download="remittance_output.csv"
      style={{ padding: "8px 16px", background: OL.orange, color: OL.white, border: "none", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, textDecoration: "none", display: "inline-block", lineHeight: "normal" }}>
      ⬇ Export CSV ({rowCount} rows)
    </a>
  );
}

function StatChip({ label, value, color }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.12)", borderRadius: 8, padding: "6px 14px", textAlign: "center", minWidth: 80 }}>
      <div style={{ color, fontWeight: 700, fontSize: 16 }}>{value}</div>
      <div style={{ color: OL.sand, fontSize: 10, marginTop: 1 }}>{label}</div>
    </div>
  );
}
