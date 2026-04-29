import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { jsPDF } from "jspdf";

// Componentes simplificados (sin dependencias externas)
function Card({ children, className = "" }) {
  return <div className={`bg-white rounded-3xl ${className}`}>{children}</div>;
}

function CardContent({ children, className = "" }) {
  return <div className={className}>{children}</div>;
}

function Button({ children, className = "", variant = "default", ...props }) {
  const base = "px-4 py-2 rounded-2xl font-semibold cursor-pointer";
  const styles = {
    default: "bg-black text-white",
    outline: "border border-gray-300 bg-white",
    secondary: "bg-gray-200",
  };
  return (
    <button className={`${base} ${styles[variant] || styles.default} ${className}`} {...props}>
      {children}
    </button>
  );
}

// =========================================================
// CONFIGURACIÓN SUPABASE
// =========================================================

const SUPABASE_URL = "https://rwebxeboopnqlzrnlslb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3ZWJ4ZWJvb3BucWx6cm5sc2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjg5NzEsImV4cCI6MjA5Mjg0NDk3MX0.utDIvdUqV1yvegQEn7B82FHnM5onJm_l0Pi1DneBWZI";
const ADMIN_PIN = "3773";
const PIN_SALT = "letras-a-la-taza-control-horario-v1";
const SIGNATURE_SALT = "letras-a-la-taza-firma-informes-v1";
const APP_VERSION = "FICHAJE-LEGAL-FINAL-1";
const recordLabels = {
  ajuste: "Ajuste manual",
  entrada: "Entrada registrada",
  salida: "Salida registrada",
  pausa_inicio: "Inicio de pausa registrado",
  pausa_fin: "Fin de pausa registrado",
};

const adjustmentLabels = {
  entrada: "Entrada olvidada",
  salida: "Salida olvidada",
  pausa_inicio: "Pausa olvidada",
  pausa_fin: "Fin de pausa olvidado",
};

function todayISO(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function currentMonthISO(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function getMonthLabel(monthISO) {
  if (!monthISO) return "";
  const [year, month] = monthISO.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
}

function nowDateTime(date = new Date()) {
  return date.toLocaleString("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function escapeCSV(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildCSV(records) {
  const header = ["Empleado", "Tipo", "Fecha", "Hora", "Nota", "Creado por"].map(escapeCSV).join(",");
  const rows = records.map((record) =>
    [record.employeeName, record.label, record.date, record.time, record.note, record.createdBy]
      .map(escapeCSV)
      .join(",")
  );

  return [header, ...rows].join("\n");
}

function getManualAdjustmentRows(records) {
  return records
    .filter((record) => record.record_type === "ajuste" || parseAdjustmentNote(record.note).isManualAdjustment)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((record) => [
      record.date,
      record.time,
      getRecordShortLabel(record),
      record.note || "Sin motivo indicado",
      record.createdBy || "Admin",
    ]);
}

function getEmployeeDisplayName(employeeId, employees) {
  return employees.find((employee) => employee.id === employeeId)?.name || "Empleado";
}

function safeFileName(value) {
  return String(value || "documento")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "documento";
}

function getNextEmployeeId(currentEmployeeId, employees) {
  const remaining = employees.filter((employee) => employee.id !== currentEmployeeId);
  return remaining[0]?.id || "";
}

function isValidPin(pin) {
  return /^\d{4,8}$/.test(String(pin ?? "").trim());
}

function isProbablyHashedPin(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

async function sha256Hex(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPin(pin) {
  const cleanPin = String(pin ?? "").trim();
  return sha256Hex(`${PIN_SALT}:${cleanPin}`);
}

async function buildReportSignature(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = await sha256Hex(`${SIGNATURE_SALT}:${canonical}`);
  return {
    hash,
    shortCode: hash.slice(0, 12).toUpperCase(),
  };
}

function addPDFText(doc, text, x, y, options = {}) {
  const maxWidth = options.maxWidth || 180;
  const lineHeight = options.lineHeight || 6;
  const lines = doc.splitTextToSize(String(text ?? ""), maxWidth);
  doc.text(lines, x, y);
  return y + lines.length * lineHeight;
}

function ensurePDFPageSpace(doc, y, needed = 24) {
  if (y + needed <= 285) return y;
  doc.addPage();
  return 20;
}

function buildPDFDocument({ title, employeeName, periodLabel, summaryCards, tableHeaders, tableRows, warnings, adjustmentRows = [], signature }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Letras a la Taza", 15, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("Sistema de control horario", 15, y);
  y += 12;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(title, 15, y);
  y += 7;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(`Versión informe: ${APP_VERSION}`, 15, y);
  y += 8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("DATOS DE EMPRESA Y CENTRO DE TRABAJO", 15, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.text("Empresa: Letras a la Taza", 15, y);
  y += 6;
  doc.text("CIF: B71209530", 15, y);
  y += 6;
  doc.text("Centro de trabajo: Tudela", 15, y);
  y += 6;
  doc.text(`Empleado: ${employeeName}`, 15, y);
  y += 6;
  doc.text(`Periodo: ${periodLabel}`, 15, y);
  y += 10;

  doc.setDrawColor(210);
  doc.line(15, y, 195, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Resumen", 15, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  summaryCards.forEach(([label, value], index) => {
    const x = 15 + (index % 2) * 90;
    if (index > 0 && index % 2 === 0) y += 8;
    doc.setFont("helvetica", "bold");
    doc.text(`${label}:`, x, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(value), x + 42, y);
  });
  y += 12;

  if (warnings.length > 0) {
    y = ensurePDFPageSpace(doc, y, 30);
    doc.setFont("helvetica", "bold");
    doc.text("Incidencias / avisos", 15, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    warnings.forEach((warning) => {
      y = ensurePDFPageSpace(doc, y, 12);
      y = addPDFText(doc, `• ${warning}`, 18, y, { maxWidth: 170, lineHeight: 5 });
    });
    y += 4;
  }

  if (signature) {
    y = ensurePDFPageSpace(doc, y, 28);
    doc.setFont("helvetica", "bold");
    doc.text("Firma y trazabilidad", 15, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.text(`Código de verificación: ${signature.shortCode}`, 15, y);
    y += 5;
    doc.text(`Generado por: ${signature.generatedBy || "Admin"}`, 15, y);
    y += 5;
    doc.text(`Generado en: ${signature.generatedAt || nowDateTime()}`, 15, y);
    y += 5;
    y = addPDFText(doc, `Huella SHA-256: ${signature.hash}`, 15, y, { maxWidth: 180, lineHeight: 5 });
    y += 5;
  }

  if (adjustmentRows.length > 0) {
    y = ensurePDFPageSpace(doc, y, 32);
    doc.setFont("helvetica", "bold");
    doc.text("Ajustes manuales registrados", 15, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    adjustmentRows.forEach((row) => {
      y = ensurePDFPageSpace(doc, y, 12);
      y = addPDFText(doc, `${row[0]} ${row[1]} · ${row[2]} · ${row[3]} · ${row[4]}`, 18, y, { maxWidth: 170, lineHeight: 5 });
    });
    y += 4;
  }

  y = ensurePDFPageSpace(doc, y, 22);
  doc.setFont("helvetica", "bold");
  doc.text("Detalle", 15, y);
  y += 7;

  const colWidths = tableHeaders.length >= 6 ? [28, 36, 20, 24, 58, 28] : [28, 32, 26, 26, 26, 42];
  const startX = 15;

  function drawHeader() {
    let x = startX;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    tableHeaders.forEach((header, index) => {
      doc.text(String(header), x, y);
      x += colWidths[index] || 28;
    });
    y += 5;
    doc.line(15, y, 195, y);
    y += 5;
    doc.setFont("helvetica", "normal");
  }

  drawHeader();

  tableRows.forEach((row) => {
    y = ensurePDFPageSpace(doc, y, 18);
    if (y === 20) drawHeader();

    let x = startX;
    const rowLines = row.map((cell, index) => doc.splitTextToSize(String(cell ?? ""), (colWidths[index] || 28) - 2));
    const rowHeight = Math.max(...rowLines.map((lines) => lines.length), 1) * 4.5;

    rowLines.forEach((lines, index) => {
      doc.text(lines, x, y);
      x += colWidths[index] || 28;
    });

    y += rowHeight + 3;
  });

  y = ensurePDFPageSpace(doc, y, 46);
  doc.setFont("helvetica", "bold");
  doc.text("DECLARACIÓN LEGAL E INTEGRIDAD DEL REGISTRO", 15, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  y = addPDFText(
    doc,
    "El presente informe recoge el registro diario de jornada conforme al artículo 34.9 del Estatuto de los Trabajadores, introducido por el Real Decreto-ley 8/2019. La empresa conservará estos registros durante el periodo legalmente exigible, quedando a disposición de la persona trabajadora, sus representantes legales y la Inspección de Trabajo y Seguridad Social.",
    15,
    y,
    { maxWidth: 180, lineHeight: 4 }
  );
  y = addPDFText(
    doc,
    "Los fichajes originales no deben modificarse ni eliminarse; cualquier corrección deberá constar como ajuste manual trazable. El código de verificación y la huella SHA-256 identifican la versión concreta del informe emitido.",
    15,
    y + 2,
    { maxWidth: 180, lineHeight: 4 }
  );
  doc.setFontSize(9);

  y = ensurePDFPageSpace(doc, y, 30);
  y += 12;
  doc.line(20, y, 90, y);
  doc.line(120, y, 190, y);
  y += 5;
  doc.setFontSize(9);
  doc.text("Firma empresa / responsable", 20, y);
  doc.text("Firma trabajador/a", 120, y);
  y += 5;
  doc.text("Nombre y DNI", 20, y);
  doc.text("Nombre y DNI", 120, y);

  return doc;
}

function downloadPDFDocument(doc, fileName) {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 1000);
}

async function verifyPin(inputPin, storedPinHash) {
  if (!storedPinHash) return false;

  // Compatibilidad temporal: empleados antiguos que todavía tengan PIN en claro.
  if (!isProbablyHashedPin(storedPinHash)) {
    return String(inputPin ?? "").trim() === String(storedPinHash).trim();
  }

  const inputHash = await hashPin(inputPin);
  return inputHash === storedPinHash;
}

function getStatusFromLatestRecord(latestRecord) {
  if (!latestRecord) return "Sin fichaje activo";
  const effectiveType = latestRecord.effectiveType || latestRecord.record_type;
  if (effectiveType === "entrada") return "Trabajando";
  if (effectiveType === "pausa_inicio") return "En pausa";
  if (effectiveType === "pausa_fin") return "Trabajando";
  if (effectiveType === "salida") return "Fuera de turno";
  if (latestRecord.record_type === "ajuste") return "Último registro: ajuste manual";
  return "Sin fichaje activo";
}

function formatMinutes(totalMinutes) {
  const safeMinutes = Math.max(0, Math.round(totalMinutes || 0));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}min`;
}

function inferAdjustmentType(record, currentState = "fuera") {
  const text = `${record.label || ""} ${record.note || ""} ${record.record_type || ""}`.toLowerCase();

  if (record.effectiveType) return record.effectiveType;

  if (text.includes("salida")) return "salida";
  if (text.includes("entrada")) return "entrada";
  if (text.includes("fin pausa") || text.includes("fin de pausa") || text.includes("volver")) return "pausa_fin";
  if (text.includes("pausa")) return "pausa_inicio";

  // Compatibilidad con ajustes antiguos sin descripción clara.
  if (record.record_type === "ajuste") {
    if (currentState === "trabajando") return "salida";
    if (currentState === "pausa") return "pausa_fin";
    return "entrada";
  }

  return record.record_type;
}

function normalizeRecordsForCalculation(dayRecords) {
  const ordered = [...dayRecords].sort((a, b) => a.createdAt - b.createdAt);
  let state = "fuera";

  return ordered.map((record) => {
    const calculationType = inferAdjustmentType(record, state);

    if (calculationType === "entrada") state = "trabajando";
    if (calculationType === "pausa_inicio") state = "pausa";
    if (calculationType === "pausa_fin") state = "trabajando";
    if (calculationType === "salida") state = "fuera";

    return { ...record, calculationType, effectiveType: record.effectiveType || (record.record_type === "ajuste" ? calculationType : record.effectiveType) };
  });
}

function validateSequenceForNewRecord(existingDayRecords, newRecord) {
  const testRecords = normalizeRecordsForCalculation([...existingDayRecords, newRecord]);

  let state = "fuera";
  const issues = [];

  for (const record of testRecords) {
    const type = record.calculationType;
    const label = `${record.date || ""} ${record.time || ""}`.trim();

    if (type === "entrada") {
      if (state === "trabajando") issues.push(`${label}: entrada cuando ya constaba trabajando.`);
      if (state === "pausa") issues.push(`${label}: entrada mientras había una pausa abierta.`);
      state = "trabajando";
    }

    if (type === "pausa_inicio") {
      if (state === "fuera") issues.push(`${label}: pausa sin entrada previa.`);
      if (state === "pausa") issues.push(`${label}: pausa iniciada dos veces.`);
      state = "pausa";
    }

    if (type === "pausa_fin") {
      if (state !== "pausa") issues.push(`${label}: fin de pausa sin pausa abierta.`);
      state = "trabajando";
    }

    if (type === "salida") {
      if (state === "fuera") issues.push(`${label}: salida sin entrada previa.`);
      if (state === "pausa") issues.push(`${label}: salida mientras la pausa estaba abierta.`);
      state = "fuera";
    }
  }

  return [...new Set(issues)];
}

function getRecordEmoji(record) {
  const type = record.effectiveType || record.record_type;
  if (record.record_type === "ajuste" || parseAdjustmentNote(record.note).isManualAdjustment) return "🛠️";
  if (type === "entrada") return "🟢";
  if (type === "salida") return "🔴";
  if (type === "pausa_inicio") return "☕";
  if (type === "pausa_fin") return "↩️";
  return "•";
}

function getRecordShortLabel(record) {
  const type = record.effectiveType || record.record_type;
  const prefix = record.record_type === "ajuste" || parseAdjustmentNote(record.note).isManualAdjustment ? "Ajuste · " : "";
  if (type === "entrada") return `${prefix}Entrada`;
  if (type === "salida") return `${prefix}Salida`;
  if (type === "pausa_inicio") return `${prefix}Pausa`;
  if (type === "pausa_fin") return `${prefix}Fin pausa`;
  return record.label || "Registro";
}

function getTimelineSegments(dayRecords) {
  const ordered = normalizeRecordsForCalculation(dayRecords);

  return ordered.map((record, index) => {
    const next = ordered[index + 1];
    const durationMinutes = next ? Math.max(0, (next.createdAt - record.createdAt) / 60000) : null;
    const type = record.calculationType;
    let segmentLabel = "Registro final";

    if (next) {
      if (type === "entrada" || type === "pausa_fin") segmentLabel = "Tiempo de trabajo";
      if (type === "pausa_inicio") segmentLabel = "Pausa";
      if (type === "salida") segmentLabel = "Fuera de turno";
      if (record.record_type === "ajuste" || parseAdjustmentNote(record.note).isManualAdjustment) segmentLabel = `Ajuste aplicado · ${segmentLabel}`;
    }

    return {
      id: record.id,
      record,
      next,
      durationMinutes,
      segmentLabel,
    };
  });
}

function calculateDailySummary(dayRecords) {
  const ordered = normalizeRecordsForCalculation(dayRecords);

  let workStart = null;
  let pauseStart = null;
  let workMinutes = 0;
  let breakMinutes = 0;
  const warnings = [];

  for (const record of ordered) {
    if (record.calculationType === "entrada") {
      if (workStart) warnings.push("Registro inconsistente: entrada registrada cuando ya constaba una entrada abierta.");
      workStart = record.createdAt;
    }

    if (record.calculationType === "pausa_inicio") {
      if (!workStart) warnings.push("Registro inconsistente: pausa iniciada sin entrada previa.");
      if (pauseStart) warnings.push("Registro inconsistente: pausa iniciada dos veces sin registrar fin de pausa.");
      pauseStart = record.createdAt;
    }

    if (record.calculationType === "pausa_fin") {
      if (!pauseStart) {
        warnings.push("Registro inconsistente: fin de pausa sin pausa abierta.");
      } else {
        breakMinutes += (record.createdAt - pauseStart) / 60000;
        pauseStart = null;
      }
    }

    if (record.calculationType === "salida") {
      if (!workStart) {
        warnings.push("Registro inconsistente: salida registrada sin entrada previa.");
      } else {
        workMinutes += (record.createdAt - workStart) / 60000;
        workStart = null;
      }

      if (pauseStart) {
        warnings.push("Registro inconsistente: salida registrada durante una pausa activa.");
        pauseStart = null;
      }
    }
  }

  if (workStart) warnings.push("Registro pendiente: entrada abierta sin salida registrada.");
  if (pauseStart) warnings.push("Registro pendiente: pausa abierta sin fin de pausa registrado.");

  const adjustmentCount = dayRecords.filter((record) => record.record_type === "ajuste" || parseAdjustmentNote(record.note).isManualAdjustment).length;
  if (adjustmentCount > 0) warnings.push(`Hay ${adjustmentCount} ajuste(s) manual(es) aplicado(s) en este día.`);

  const netWorkMinutes = Math.max(0, workMinutes - breakMinutes);

  return {
    grossWorkMinutes: workMinutes,
    breakMinutes,
    netWorkMinutes,
    warnings: [...new Set(warnings)],
    recordsCount: dayRecords.length,
    adjustmentCount,
  };
}

function calculateMonthlySummary(monthRecords) {
  const recordsByDate = monthRecords.reduce((acc, record) => {
    if (!acc[record.date]) acc[record.date] = [];
    acc[record.date].push(record);
    return acc;
  }, {});

  const days = Object.entries(recordsByDate)
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, dayRecords]) => {
      const summary = calculateDailySummary(dayRecords);
      return { date, records: dayRecords, summary };
    });

  const totals = days.reduce(
    (acc, day) => {
      acc.netWorkMinutes += day.summary.netWorkMinutes;
      acc.breakMinutes += day.summary.breakMinutes;
      acc.grossWorkMinutes += day.summary.grossWorkMinutes;
      acc.recordsCount += day.summary.recordsCount;
      acc.warningCount += day.summary.warnings.length;
      acc.adjustmentCount += day.summary.adjustmentCount;
      return acc;
    },
    { netWorkMinutes: 0, breakMinutes: 0, grossWorkMinutes: 0, recordsCount: 0, warningCount: 0, adjustmentCount: 0 }
  );

  return { days, totals };
}

function buildDailyReportHTML({ employeeName, filterDate, dailySummary, filteredRecords, signature }) {
  return buildReportHTML({
    title: "Informe diario de fichaje",
    documentLabel: "Informe diario de fichaje",
    employeeName,
    periodLabel: filterDate,
    summaryCards: [
      ["Trabajo bruto", formatMinutes(dailySummary.grossWorkMinutes)],
      ["Pausas", formatMinutes(dailySummary.breakMinutes)],
      ["Trabajo neto", formatMinutes(dailySummary.netWorkMinutes)],
      ["Ajustes", dailySummary.adjustmentCount],
    ],
    tableHeaders: ["Empleado", "Tipo", "Hora", "Fecha", "Nota", "Creado por"],
    tableRows: filteredRecords.map((record) => [record.employeeName, record.label, record.time, record.date, record.note || "", record.createdBy || "Sistema"]),
    warnings: dailySummary.warnings,
    adjustmentRows: getManualAdjustmentRows(filteredRecords),
    signature,
  });
}

function buildMonthlyReportHTML({ employeeName, monthISO, monthlySummary, signature }) {
  const rows = monthlySummary.days.map((day) => [
    day.date,
    formatMinutes(day.summary.netWorkMinutes),
    formatMinutes(day.summary.breakMinutes),
    day.summary.recordsCount,
    day.summary.adjustmentCount,
    day.summary.warnings.length ? day.summary.warnings.join(" · ") : "Sin incidencias",
  ]);

  const warnings = monthlySummary.days.flatMap((day) =>
    day.summary.warnings.map((warning) => `${day.date}: ${warning}`)
  );

  return buildReportHTML({
    title: `Informe mensual de fichaje - ${getMonthLabel(monthISO)}`,
    documentLabel: "Informe mensual de fichaje",
    employeeName,
    periodLabel: getMonthLabel(monthISO),
    summaryCards: [
      ["Trabajo bruto mensual", formatMinutes(monthlySummary.totals.grossWorkMinutes)],
      ["Pausas mensuales", formatMinutes(monthlySummary.totals.breakMinutes)],
      ["Trabajo neto mensual", formatMinutes(monthlySummary.totals.netWorkMinutes)],
      ["Ajustes", monthlySummary.totals.adjustmentCount],
    ],
    tableHeaders: ["Día", "Trabajo neto", "Pausas", "Registros", "Ajustes", "Incidencias"],
    tableRows: rows,
    warnings,
    adjustmentRows: getManualAdjustmentRows(monthlySummary.days.flatMap((day) => day.records)),
    signature,
  });
}

function buildReportHTML({ title, documentLabel, employeeName, periodLabel, summaryCards, tableHeaders, tableRows, warnings, adjustmentRows = [], signature }) {
  const safeEmployeeName = escapeHTML(employeeName || "Empleado");
  const safePeriodLabel = escapeHTML(periodLabel || "");
  const generatedAt = escapeHTML(nowDateTime());
  const headerCells = tableHeaders.map((header) => `<th>${escapeHTML(header)}</th>`).join("");
  const bodyRows = tableRows.length
    ? tableRows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHTML(cell)}</td>`).join("")}</tr>`)
        .join("")
    : `<tr><td colspan="${tableHeaders.length}" class="empty">No hay fichajes para este periodo.</td></tr>`;

  const warningsBlock = warnings.length
    ? `
      <section class="warnings">
        <h3>Incidencias / avisos</h3>
        <ul>
          ${warnings.map((warning) => `<li>${escapeHTML(warning)}</li>`).join("")}
        </ul>
      </section>`
    : "";

  const cards = summaryCards
    .map(
      ([label, value]) => `
        <div class="summary-card">
          <div class="summary-label">${escapeHTML(label)}</div>
          <div class="summary-value">${escapeHTML(value)}</div>
        </div>`
    )
    .join("");

  const signatureBlock = signature
    ? `
      <section class="verification">
        <h3>Firma y trazabilidad</h3>
        <div><strong>Código de verificación:</strong> ${escapeHTML(signature.shortCode)}</div>
        <div><strong>Huella SHA-256:</strong> <span class="hash">${escapeHTML(signature.hash)}</span></div>
        <div><strong>Generado por:</strong> ${escapeHTML(signature.generatedBy || "Admin")}</div>
        <div><strong>Generado en:</strong> ${escapeHTML(signature.generatedAt || generatedAt)}</div>
      </section>`
    : "";

  const adjustmentBlock = adjustmentRows.length
    ? `
      <section class="adjustments">
        <h3>Ajustes manuales registrados</h3>
        <table>
          <thead><tr><th>Fecha</th><th>Hora</th><th>Tipo</th><th>Motivo</th><th>Responsable</th></tr></thead>
          <tbody>
            ${adjustmentRows
              .map((row) => `<tr>${row.map((cell) => `<td>${escapeHTML(cell)}</td>`).join("")}</tr>`)
              .join("")}
          </tbody>
        </table>
      </section>`
    : "";

  const legalBlock = `
      <section class="legal-note">
        <h3>Declaración legal e integridad del registro</h3>
        <p>El presente informe recoge el registro diario de jornada de la persona trabajadora conforme a lo establecido en el artículo 34.9 del Estatuto de los Trabajadores, introducido por el Real Decreto-ley 8/2019.</p>
        <p>La empresa conservará estos registros durante el periodo legalmente exigible, quedando a disposición de la persona trabajadora, de sus representantes legales y de la Inspección de Trabajo y Seguridad Social.</p>
        <p>Los datos reflejados se corresponden con los registros almacenados en el sistema de control horario. Los fichajes originales no deben modificarse ni eliminarse; cualquier corrección deberá constar como ajuste manual trazable, indicando fecha, hora, responsable y motivo.</p>
        <p>El código de verificación y la huella SHA-256 identifican la versión concreta del informe emitido. Cualquier alteración posterior de los datos utilizados para generar este informe producirá una huella distinta.</p>
      </section>`;

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHTML(title)} - ${safeEmployeeName}</title>
    <style>
      @page { size: A4; margin: 18mm; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111827; background: #ffffff; }
      .document { width: 100%; }
      .header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #111827; padding-bottom: 18px; margin-bottom: 26px; }
      .brand { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; }
      .subtitle { margin-top: 6px; font-size: 15px; color: #4b5563; }
      .meta { text-align: right; font-size: 12px; line-height: 1.6; color: #4b5563; }
      h1 { margin: 0 0 16px; font-size: 22px; }
      .employee-box { border: 1px solid #d1d5db; border-radius: 14px; padding: 16px; margin-bottom: 18px; background: #f9fafb; }
      .employee-box strong { display: inline-block; min-width: 90px; }
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0; }
      .summary-card { border: 1px solid #d1d5db; border-radius: 14px; padding: 14px; background: #ffffff; }
      .summary-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 8px; }
      .summary-value { font-size: 20px; font-weight: 800; }
      table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 12px; }
      th { background: #111827; color: white; text-align: left; padding: 9px; }
      td { border-bottom: 1px solid #e5e7eb; padding: 9px; vertical-align: top; }
      tr:nth-child(even) td { background: #f9fafb; }
      .empty { text-align: center; color: #6b7280; padding: 24px; }
      .warnings { margin-top: 18px; border: 1px solid #f59e0b; border-radius: 14px; background: #fffbeb; padding: 14px; }
      .verification { margin-top: 18px; border: 1px solid #111827; border-radius: 14px; background: #f9fafb; padding: 14px; font-size: 12px; line-height: 1.6; }
      .adjustments { margin-top: 18px; border: 1px solid #d1d5db; border-radius: 14px; background: #ffffff; padding: 14px; }
      .adjustments h3 { margin: 0 0 8px; font-size: 15px; }
      .adjustments table { margin-top: 8px; }
      .legal-note { margin-top: 18px; border: 1px solid #d1d5db; border-radius: 14px; background: #f9fafb; padding: 14px; font-size: 11px; line-height: 1.5; color: #374151; }
      .legal-note h3 { margin: 0 0 8px; font-size: 14px; color: #111827; }
      .verification h3 { margin: 0 0 8px; font-size: 15px; }
      .hash { word-break: break-all; font-family: monospace; }
      .warnings h3 { margin: 0 0 8px; font-size: 15px; }
      .warnings ul { margin: 0; padding-left: 20px; }
      .footer { margin-top: 34px; padding-top: 14px; border-top: 1px solid #d1d5db; font-size: 11px; color: #6b7280; line-height: 1.5; }
      .signature { margin-top: 36px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; font-size: 12px; }
      .signature-line { border-top: 1px solid #111827; padding-top: 8px; color: #4b5563; }
      @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
    </style>
  </head>
  <body>
    <main class="document">
      <header class="header">
        <div><div class="brand">Letras a la Taza</div><div class="subtitle">Sistema de control horario</div></div>
        <div class="meta"><div><strong>Documento:</strong> ${escapeHTML(documentLabel)}</div><div><strong>Generado:</strong> ${generatedAt}</div></div>
      </header>
      <h1>${escapeHTML(documentLabel)}</h1>
      <section class="employee-box"><div><strong>Empresa:</strong> Letras a la Taza</div><div><strong>CIF:</strong> B71209530</div><div><strong>Centro de trabajo:</strong> Tudela</div><div><strong>Empleado:</strong> ${safeEmployeeName}</div><div><strong>Periodo:</strong> ${safePeriodLabel}</div></section>
      <section class="summary">${cards}</section>
      ${warningsBlock}
      ${signatureBlock}
      ${adjustmentBlock}
      <table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>
      ${legalBlock}
      <section class="signature"><div class="signature-line">Firma empresa / responsable<br/>Nombre y DNI</div><div class="signature-line">Firma trabajador/a<br/>Nombre y DNI</div></section>
      <footer class="footer">Documento generado automáticamente a partir de los registros de fichaje guardados en la base de datos. Cualquier corrección deberá constar como ajuste, sin modificar el registro original.</footer>
    </main>
  </body>
</html>`;
}

function runSelfTests() {
  console.assert(getStatusFromLatestRecord(null) === "Sin fichaje activo", "Test estado sin fichaje");
  console.assert(getStatusFromLatestRecord({ record_type: "entrada" }) === "Trabajando", "Test estado entrada");
  console.assert(getStatusFromLatestRecord({ record_type: "pausa_inicio" }) === "En pausa", "Test estado pausa");
  console.assert(getStatusFromLatestRecord({ record_type: "pausa_fin" }) === "Trabajando", "Test estado vuelta de pausa");
  console.assert(getStatusFromLatestRecord({ record_type: "salida" }) === "Fuera de turno", "Test estado salida");
  console.assert(getStatusFromLatestRecord({ record_type: "ajuste" }).includes("ajuste"), "Test estado ajuste");
  console.assert(getRecordShortLabel({ record_type: "ajuste", effectiveType: "salida" }) === "Ajuste · Salida", "Test etiqueta timeline ajuste");
  console.assert(getTimelineSegments([
    { id: "a", record_type: "entrada", createdAt: new Date("2026-04-27T09:00:00").getTime() },
    { id: "b", record_type: "salida", createdAt: new Date("2026-04-27T14:00:00").getTime() },
  ])[0].durationMinutes === 300, "Test duración timeline");
  const legacyAdjustmentSummary = calculateDailySummary([
    { record_type: "entrada", createdAt: new Date("2026-04-28T15:52:00").getTime() },
    { record_type: "ajuste", createdAt: new Date("2026-04-28T20:30:00").getTime(), note: "" },
  ]);
  console.assert(legacyAdjustmentSummary.netWorkMinutes === 278, "Test ajuste antiguo computa como salida si hay entrada abierta");
  const explicitExitAdjustmentSummary = calculateDailySummary([
    { record_type: "entrada", createdAt: new Date("2026-04-28T15:52:00").getTime() },
    { record_type: "ajuste", label: "Ajuste manual", note: "Salida olvidada", createdAt: new Date("2026-04-28T20:30:00").getTime() },
  ]);
  console.assert(explicitExitAdjustmentSummary.netWorkMinutes === 278, "Test ajuste con texto salida computa como salida");
  const sequenceIssues = validateSequenceForNewRecord(
    [{ record_type: "entrada", date: "2026-04-27", time: "09:00", createdAt: new Date("2026-04-27T09:00:00").getTime() }],
    { record_type: "entrada", date: "2026-04-27", time: "10:00", createdAt: new Date("2026-04-27T10:00:00").getTime() }
  );
  console.assert(sequenceIssues.length > 0, "Test validación secuencia flexible");
  console.assert(escapeCSV('Letras "a" la Taza') === '"Letras ""a"" la Taza"', "Test escape CSV");
  console.assert(buildCSV([{ employeeName: "Miguel", label: "Entrada", date: "2026-04-27", time: "09:00", note: "", createdBy: "Sistema" }]).includes("\n"), "Test CSV newline");
  console.assert(escapeHTML("<Miguel & Eva>") === "&lt;Miguel &amp; Eva&gt;", "Test escape HTML");

  const summary = calculateDailySummary([
    { record_type: "entrada", createdAt: new Date("2026-04-27T09:00:00").getTime() },
    { record_type: "pausa_inicio", createdAt: new Date("2026-04-27T11:00:00").getTime() },
    { record_type: "pausa_fin", createdAt: new Date("2026-04-27T11:15:00").getTime() },
    { record_type: "salida", createdAt: new Date("2026-04-27T14:00:00").getTime() },
    { record_type: "ajuste", createdAt: new Date("2026-04-27T14:05:00").getTime() },
  ]);
  console.assert(summary.netWorkMinutes === 285, "Test cálculo horas netas");
  console.assert(summary.breakMinutes === 15, "Test cálculo pausa");
  console.assert(summary.adjustmentCount === 1, "Test conteo ajuste diario");

  const reportHTML = buildDailyReportHTML({
    employeeName: "Miguel Iglesias",
    filterDate: "2026-04-27",
    dailySummary: summary,
    filteredRecords: [
      {
        employeeName: "Miguel Iglesias",
        label: "Entrada registrada",
        time: "09:00",
        date: "2026-04-27",
        note: "",
      },
    ],
  });
  console.assert(reportHTML.includes("Informe diario de fichaje"), "Test informe HTML título");
  console.assert(reportHTML.includes("Miguel Iglesias"), "Test informe HTML empleado");
  console.assert(reportHTML.includes("Firma trabajador/a"), "Test informe HTML firma");

  const monthlySummary = calculateMonthlySummary([
    { record_type: "entrada", date: "2026-04-01", createdAt: new Date("2026-04-01T09:00:00").getTime() },
    { record_type: "salida", date: "2026-04-01", createdAt: new Date("2026-04-01T14:00:00").getTime() },
    { record_type: "entrada", date: "2026-04-02", createdAt: new Date("2026-04-02T10:00:00").getTime() },
    { record_type: "salida", date: "2026-04-02", createdAt: new Date("2026-04-02T12:00:00").getTime() },
    { record_type: "ajuste", date: "2026-04-02", createdAt: new Date("2026-04-02T12:05:00").getTime() },
  ]);
  console.assert(monthlySummary.totals.netWorkMinutes === 420, "Test cálculo mensual");
  console.assert(monthlySummary.totals.adjustmentCount === 1, "Test conteo ajuste mensual");
  const monthlyHTML = buildMonthlyReportHTML({ employeeName: "Miguel Iglesias", monthISO: "2026-04", monthlySummary });
  console.assert(monthlyHTML.includes("Informe mensual de fichaje"), "Test informe mensual HTML");

  const canSelectText = typeof document !== "undefined";
  console.assert(canSelectText, "Test entorno DOM disponible para selección manual");
  console.assert(getEmployeeDisplayName("1", [{ id: "1", name: "Miguel" }]) === "Miguel", "Test nombre empleado por ID");
  console.assert(safeFileName("Miguel Iglesias") === "miguel-iglesias", "Test nombre archivo seguro");
  const testPdf = buildPDFDocument({
    title: "Informe test",
    employeeName: "Miguel",
    periodLabel: "2026-04",
    summaryCards: [["Trabajo", "1h 00min"]],
    tableHeaders: ["Día", "Horas"],
    tableRows: [["2026-04-27", "1h 00min"]],
    warnings: [],
    signature: null,
  });
  console.assert(typeof testPdf.output === "function", "Test generación PDF");
  console.assert(getNextEmployeeId("1", [{ id: "1" }, { id: "2" }]) === "2", "Test siguiente empleado tras baja");
  console.assert(isValidPin("1234"), "Test PIN válido");
  console.assert(!isValidPin("12"), "Test PIN demasiado corto");
  console.assert(ADMIN_PIN.length >= 4, "Test PIN admin mínimo");
  console.assert(isProbablyHashedPin("a".repeat(64)), "Test detección PIN hasheado");
  console.assert(!isProbablyHashedPin("1234"), "Test detección PIN antiguo en claro");
}

function MiniIcon({ children }) {
  return <span className="mr-2 inline-flex h-5 w-5 items-center justify-center text-base">{children}</span>;
}

async function supabaseRequest(path, options = {}) {
  const cleanUrl = SUPABASE_URL.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const cleanPath = path.replace(/^\/+/, "");

  if (!cleanUrl.includes("supabase.co") || !SUPABASE_ANON_KEY.startsWith("ey")) {
    throw new Error("Faltan las claves de Supabase. Pega tu Project URL y anon public key en el código.");
  }

  const response = await fetch(`${cleanUrl}/rest/v1/${cleanPath}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message || data?.hint || response.statusText;
    throw new Error(message);
  }

  return data;
}

function parseAdjustmentNote(note) {
  const text = String(note || "");
  const match = text.match(/^Ajuste manual \[(entrada|salida|pausa_inicio|pausa_fin)\] · (.+)$/);
  if (!match) return { effectiveType: null, cleanNote: text, isManualAdjustment: false };
  return { effectiveType: match[1], cleanNote: match[2], isManualAdjustment: true };
}

function mapRecordFromDatabase(record, employees) {
  const employee = employees.find((item) => item.id === record.employee_id);
  const date = new Date(record.recorded_at);
  const rawNote = record.note || record.notes || "";
  const parsedAdjustment = parseAdjustmentNote(rawNote);
  const isManualAdjustment = parsedAdjustment.isManualAdjustment || record.record_type === "ajuste";
  const effectiveType = parsedAdjustment.effectiveType || (record.record_type === "ajuste" ? null : record.record_type);
  const adjustmentSuffix = isManualAdjustment && effectiveType ? ` (${adjustmentLabels[effectiveType] || effectiveType})` : "";

  return {
    id: record.id,
    employeeId: record.employee_id,
    employeeName: employee?.name || "Empleado sin nombre",
    record_type: record.record_type,
    effectiveType,
    label: isManualAdjustment ? `Ajuste manual${adjustmentSuffix}` : recordLabels[record.record_type] || record.record_type,
    date: record.local_date || record.recorded_at.slice(0, 10),
    time: date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
    createdAt: date.getTime(),
    note: parsedAdjustment.cleanNote,
    createdBy: record.created_by || (isManualAdjustment ? "Admin" : "Sistema"),
  };
}

export default function AppFichajeEmpleados() {
  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [pin, setPin] = useState("");
  const [records, setRecords] = useState([]);
  const [message, setMessage] = useState("Cargando empleados desde Supabase...");
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [filterDate, setFilterDate] = useState(todayISO());
  const [filterMonth, setFilterMonth] = useState(currentMonthISO());
  const [currentDateTime, setCurrentDateTime] = useState(nowDateTime());
  const [isLoading, setIsLoading] = useState(false);
  const [reportHTML, setReportHTML] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [printMode, setPrintMode] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [showRawHTML, setShowRawHTML] = useState(false);
  const [viewMode, setViewMode] = useState("kiosk");
  const [adminPin, setAdminPin] = useState("");
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [resetPinEmployeeId, setResetPinEmployeeId] = useState("");
  const [resetPinValue, setResetPinValue] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustType, setAdjustType] = useState("salida");
  const [adjustDate, setAdjustDate] = useState(todayISO());
  const [adjustTime, setAdjustTime] = useState("12:00");
  const [adminName, setAdminName] = useState("Admin");
  const [lastSignature, setLastSignature] = useState(null);
  const reportTextAreaRef = useRef(null);

  useEffect(() => {
    runSelfTests();

    const interval = window.setInterval(() => {
      setCurrentDateTime(nowDateTime());
    }, 30000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!testMode) {
      loadInitialData();
    } else {
      loadTestData();
    }
  }, [testMode]);

  function loadTestData() {
    const today = todayISO();
    const month = currentMonthISO();
    const mockEmployees = [
      { id: "1", name: "Miguel Iglesias", pin: "1234", organizationId: "org1" },
      { id: "2", name: "Equipo Librería", pin: "2222", organizationId: "org1" },
    ];

    const mockRecords = [
      { id: "r1", employeeId: "1", employeeName: "Miguel Iglesias", record_type: "entrada", label: "Entrada registrada", date: today, time: "09:00", createdAt: new Date(`${today}T09:00:00`).getTime(), note: "" },
      { id: "r2", employeeId: "1", employeeName: "Miguel Iglesias", record_type: "pausa_inicio", label: "Inicio de pausa registrado", date: today, time: "11:00", createdAt: new Date(`${today}T11:00:00`).getTime(), note: "" },
      { id: "r3", employeeId: "1", employeeName: "Miguel Iglesias", record_type: "pausa_fin", label: "Fin de pausa registrado", date: today, time: "11:15", createdAt: new Date(`${today}T11:15:00`).getTime(), note: "" },
      { id: "r4", employeeId: "1", employeeName: "Miguel Iglesias", record_type: "salida", label: "Salida registrada", date: today, time: "14:00", createdAt: new Date(`${today}T14:00:00`).getTime(), note: "" },
      { id: "r5", employeeId: "2", employeeName: "Equipo Librería", record_type: "entrada", label: "Entrada registrada", date: `${month}-01`, time: "10:00", createdAt: new Date(`${month}-01T10:00:00`).getTime(), note: "" },
      { id: "r6", employeeId: "2", employeeName: "Equipo Librería", record_type: "salida", label: "Salida registrada", date: `${month}-01`, time: "13:00", createdAt: new Date(`${month}-01T13:00:00`).getTime(), note: "" },
    ];

    setEmployees(mockEmployees.map((employee) => ({ ...employee, isActive: true })));
    setSelectedEmployeeId("1");
    setRecords(mockRecords);
    setMessage("Modo prueba activado.");
  }

  const activeEmployees = useMemo(() => employees.filter((employee) => employee.isActive !== false), [employees]);
  const inactiveEmployees = useMemo(() => employees.filter((employee) => employee.isActive === false), [employees]);
  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId);

  const filteredRecords = useMemo(() => {
    return records
      .filter((record) => record.date === filterDate && record.employeeId === selectedEmployeeId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [records, filterDate, selectedEmployeeId]);

  const selectedEmployeeMonthRecords = useMemo(() => {
    return records.filter(
      (record) => record.date.startsWith(filterMonth) && record.employeeId === selectedEmployeeId
    );
  }, [records, filterMonth, selectedEmployeeId]);

  const monthlySummary = useMemo(() => {
    return calculateMonthlySummary(selectedEmployeeMonthRecords);
  }, [selectedEmployeeMonthRecords]);

  const selectedEmployeeDayRecords = useMemo(() => {
    return records.filter(
      (record) => record.date === filterDate && record.employeeId === selectedEmployeeId
    );
  }, [records, filterDate, selectedEmployeeId]);

  const dailySummary = useMemo(() => {
    return calculateDailySummary(selectedEmployeeDayRecords);
  }, [selectedEmployeeDayRecords]);

  const dayTimeline = useMemo(() => {
    return getTimelineSegments(selectedEmployeeDayRecords);
  }, [selectedEmployeeDayRecords]);

  const daySequenceIssues = useMemo(() => {
    const ordered = [...selectedEmployeeDayRecords].sort((a, b) => a.createdAt - b.createdAt);
    if (ordered.length === 0) return [];
    const last = ordered[ordered.length - 1];
    return validateSequenceForNewRecord(ordered.slice(0, -1), last);
  }, [selectedEmployeeDayRecords]);

  const currentStatus = useMemo(() => {
    const latest = records
      .filter((record) => record.employeeId === selectedEmployeeId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    return getStatusFromLatestRecord(latest);
  }, [records, selectedEmployeeId]);

  async function loadInitialData() {
    setIsLoading(true);
    try {
      let employeeRows;
      try {
        employeeRows = await supabaseRequest("employees?select=id,organization_id,full_name,pin_hash,is_active&order=full_name.asc");
      } catch (error) {
        const missingActiveColumn = error.message.includes("is_active") || error.message.includes("schema cache");
        if (!missingActiveColumn) throw error;
        employeeRows = await supabaseRequest("employees?select=id,organization_id,full_name,pin_hash&order=full_name.asc");
      }
      const mappedEmployees = employeeRows.map((employee) => ({
        id: employee.id,
        organizationId: employee.organization_id,
        name: employee.full_name,
        pin: employee.pin_hash,
        isActive: employee.is_active !== false,
      }));

      setEmployees(mappedEmployees);
      setSelectedEmployeeId((current) => current || mappedEmployees.find((employee) => employee.isActive)?.id || mappedEmployees[0]?.id || "");

      let recordRows;
      try {
        recordRows = await supabaseRequest("time_records?select=id,employee_id,record_type,recorded_at,local_date,note,created_by&order=recorded_at.desc&limit=500");
      } catch (error) {
        const missingNote = error.message.includes("note") || error.message.includes("schema cache");
        if (!missingNote) throw error;
        recordRows = await supabaseRequest("time_records?select=id,employee_id,record_type,recorded_at,local_date&order=recorded_at.desc&limit=500");
      }

      setRecords(recordRows.map((record) => mapRecordFromDatabase(record, mappedEmployees)));
      setMessage(mappedEmployees.length ? "Datos cargados desde Supabase." : "No hay empleados todavía. Crea el primero desde Supabase o desde esta pantalla.");
    } catch (error) {
      setMessage(`Error cargando Supabase: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function validatePin() {
    if (!selectedEmployee) return false;
    return verifyPin(pin, selectedEmployee.pin);
  }

  async function addRecord(type) {
    if (!selectedEmployee) {
      setMessage("Primero selecciona un empleado.");
      return;
    }

    if (!(await validatePin())) {
      setMessage("PIN incorrecto. Revisa el código antes de fichar.");
      return;
    }

    if (testMode) {
      const now = new Date();
      const newRecord = {
        id: `test-${Date.now()}`,
        employeeId: selectedEmployee.id,
        employeeName: selectedEmployee.name,
        record_type: type,
        label: recordLabels[type],
        date: todayISO(now),
        time: now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }),
        createdAt: now.getTime(),
        note: "",
      };
      const issues = validateSequenceForNewRecord(selectedEmployeeDayRecords, newRecord);
      setRecords((current) => [newRecord, ...current]);
      setPin("");
      setMessage(issues.length ? `${recordLabels[type]} de prueba registrado con aviso: ${issues[0]}` : `${recordLabels[type]} de prueba para ${selectedEmployee.name}.`);
      return;
    }

    setIsLoading(true);
    try {
      const fullPayload = {
        organization_id: selectedEmployee.organizationId,
        employee_id: selectedEmployee.id,
        record_type: type,
        local_date: todayISO(),
        source: "app",
      };

      const basicPayload = {
        employee_id: selectedEmployee.id,
        record_type: type,
      };

      let inserted;
      try {
        inserted = await supabaseRequest("time_records", {
          method: "POST",
          body: JSON.stringify(fullPayload),
        });
      } catch (error) {
        const schemaCacheError =
          error.message.includes("schema cache") ||
          error.message.includes("local_date") ||
          error.message.includes("organization_id") ||
          error.message.includes("source");

        if (!schemaCacheError) throw error;

        inserted = await supabaseRequest("time_records", {
          method: "POST",
          body: JSON.stringify(basicPayload),
        });
      }

      const newRecord = mapRecordFromDatabase(inserted[0], employees);
      const issues = validateSequenceForNewRecord(selectedEmployeeDayRecords, newRecord);
      setRecords((current) => [newRecord, ...current]);
      setMessage(issues.length ? `${recordLabels[type]} para ${selectedEmployee.name} a las ${newRecord.time}. Aviso: ${issues[0]}` : `${recordLabels[type]} para ${selectedEmployee.name} a las ${newRecord.time}.`);
      setPin("");
    } catch (error) {
      setMessage(`Error guardando fichaje: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function addAdjustment() {
    if (!selectedEmployee) {
      setMessage("Selecciona un empleado.");
      return;
    }

    if (!adjustNote.trim()) {
      setMessage("Debes indicar motivo del ajuste.");
      return;
    }

    const adjustmentDateTime = new Date(`${adjustDate}T${adjustTime}:00`);
    if (Number.isNaN(adjustmentDateTime.getTime())) {
      setMessage("La fecha u hora del ajuste no son válidas.");
      return;
    }

    const note = `Ajuste manual [${adjustType}] · ${adjustmentLabels[adjustType]}: ${adjustNote.trim()}`;

    if (testMode) {
      const newRecord = {
        id: `adj-${Date.now()}`,
        employeeId: selectedEmployee.id,
        employeeName: selectedEmployee.name,
        record_type: adjustType,
        label: `Ajuste manual (${adjustmentLabels[adjustType]})`,
        date: adjustDate,
        time: adjustTime,
        createdAt: adjustmentDateTime.getTime(),
        note: parseAdjustmentNote(note).cleanNote,
        effectiveType: adjustType,
      };
      const dayRecordsForAdjustment = records.filter(
        (record) => record.date === adjustDate && record.employeeId === selectedEmployeeId
      );
      const issues = validateSequenceForNewRecord(dayRecordsForAdjustment, newRecord);
      setRecords((current) => [newRecord, ...current]);
      setAdjustNote("");
      setMessage(issues.length ? `Ajuste registrado en modo prueba con aviso: ${issues[0]}` : "Ajuste registrado en modo prueba.");
      return;
    }

    setIsLoading(true);
    try {
      const payloadWithNote = {
        organization_id: selectedEmployee.organizationId,
        employee_id: selectedEmployee.id,
        record_type: adjustType,
        local_date: adjustDate,
        recorded_at: adjustmentDateTime.toISOString(),
        source: "admin_adjustment",
        note,
        created_by: adminName || "Admin",
      };

      const payloadWithoutNote = {
        organization_id: selectedEmployee.organizationId,
        employee_id: selectedEmployee.id,
        record_type: adjustType,
        local_date: adjustDate,
        recorded_at: adjustmentDateTime.toISOString(),
        source: "admin_adjustment",
      };

      let inserted;
      try {
        inserted = await supabaseRequest("time_records", {
          method: "POST",
          body: JSON.stringify(payloadWithNote),
        });
      } catch (error) {
        const missingNote = error.message.includes("note") || error.message.includes("schema cache");
        if (!missingNote) throw error;
        inserted = await supabaseRequest("time_records", {
          method: "POST",
          body: JSON.stringify(payloadWithoutNote),
        });
      }

      const newRecord = { ...mapRecordFromDatabase(inserted[0], employees), note: parseAdjustmentNote(note).cleanNote, effectiveType: adjustType, date: adjustDate, time: adjustTime, createdAt: adjustmentDateTime.getTime(), createdBy: adminName || "Admin" };
      const dayRecordsForAdjustment = records.filter(
        (record) => record.date === adjustDate && record.employeeId === selectedEmployeeId
      );
      const issues = validateSequenceForNewRecord(dayRecordsForAdjustment, newRecord);
      setRecords((current) => [newRecord, ...current]);
      setAdjustNote("");
      setMessage(issues.length ? `Ajuste guardado con aviso: ${issues[0]}` : "Ajuste guardado correctamente con fecha y hora indicadas.");
    } catch (error) {
      setMessage(`Error guardando ajuste: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function addEmployee() {
    const cleanName = newName.trim();
    const cleanPin = newPin.trim();

    if (!cleanName || !cleanPin) {
      setMessage("Para crear empleado necesitas nombre y PIN.");
      return;
    }

    if (!isValidPin(cleanPin)) {
      setMessage("El PIN debe tener entre 4 y 8 números.");
      return;
    }

    const duplicated = employees.some((employee) => employee.name.toLowerCase() === cleanName.toLowerCase());
    if (duplicated) {
      setMessage("Ese empleado ya existe en el listado.");
      return;
    }

    if (testMode) {
      const employee = {
        id: `test-employee-${Date.now()}`,
        organizationId: "org1",
        name: cleanName,
        pin: await hashPin(cleanPin),
      };
      setEmployees((current) => [...current, { ...employee, isActive: true }]);
      setNewName("");
      setNewPin("");
      setMessage(`Empleado de prueba añadido: ${employee.name}. Selecciónalo en Admin para ver sus informes.`);
      return;
    }

    setIsLoading(true);
    try {
      const organizations = await supabaseRequest("organizations?select=id&limit=1");
      const organizationId = organizations[0]?.id;

      if (!organizationId) throw new Error("No existe ninguna organización. Crea primero Letras a la Taza en organizations.");

      const payload = {
        organization_id: organizationId,
        full_name: cleanName,
        pin_hash: await hashPin(cleanPin),
        is_active: true,
      };

      let inserted;
      try {
        inserted = await supabaseRequest("employees", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } catch (error) {
        const missingActiveColumn = error.message.includes("is_active") || error.message.includes("schema cache");
        if (!missingActiveColumn) throw error;

        const fallbackPayload = {
          organization_id: organizationId,
          full_name: cleanName,
          pin_hash: payload.pin_hash,
        };

        inserted = await supabaseRequest("employees", {
          method: "POST",
          body: JSON.stringify(fallbackPayload),
        });
      }

      const employee = {
        id: inserted[0].id,
        organizationId: inserted[0].organization_id,
        name: inserted[0].full_name,
        pin: inserted[0].pin_hash,
      };

      setEmployees((current) => [...current, { ...employee, isActive: true }]);
      setNewName("");
      setNewPin("");
      setMessage(`Empleado añadido en Supabase: ${employee.name}. Selecciónalo en Admin para ver sus informes.`);
    } catch (error) {
      setMessage(`Error creando empleado: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function deactivateEmployee(employeeId) {
    const employee = employees.find((item) => item.id === employeeId);
    if (!employee) {
      setMessage("No se encontró el empleado.");
      return;
    }

    const confirmed = window.confirm(`¿Dar de baja a ${employee.name}? Sus fichajes históricos se conservarán.`);
    if (!confirmed) return;

    if (testMode) {
      setEmployees((current) => current.map((item) => item.id === employeeId ? { ...item, isActive: false } : item));
      setSelectedEmployeeId((current) => (current === employeeId ? getNextEmployeeId(employeeId, activeEmployees) : current));
      setMessage(`Empleado de prueba dado de baja: ${employee.name}.`);
      return;
    }

    setIsLoading(true);
    try {
      try {
        const updatedRows = await supabaseRequest(`employees?id=eq.${employeeId}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: false }),
        });

        if (!updatedRows || updatedRows.length === 0) {
          throw new Error("Supabase no ha actualizado ningún empleado. Revisa que el id exista y que la tabla permita UPDATE.");
        }
      } catch (error) {
        const missingActiveColumn = error.message.includes("is_active") || error.message.includes("schema cache");
        if (!missingActiveColumn) throw error;
        throw new Error("Falta la columna is_active en employees. Ejecuta en Supabase: alter table employees add column if not exists is_active boolean default true; notify pgrst, 'reload schema';");
      }

      setEmployees((current) => current.map((item) => item.id === employeeId ? { ...item, isActive: false } : item));
      setSelectedEmployeeId((current) => (current === employeeId ? getNextEmployeeId(employeeId, activeEmployees) : current));
      await loadInitialData();
      setMessage(`Empleado dado de baja: ${employee.name}. Sus fichajes históricos se conservan.`);
    } catch (error) {
      setMessage(`Error dando de baja empleado: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function startResetPin(employeeId) {
    setResetPinEmployeeId(employeeId);
    setResetPinValue("");
    const employeeName = getEmployeeDisplayName(employeeId, employees);
    setMessage(`Introduce un nuevo PIN para ${employeeName}.`);
  }

  async function resetEmployeePin() {
    if (!resetPinEmployeeId) {
      setMessage("Selecciona primero un empleado.");
      return;
    }

    if (!isValidPin(resetPinValue)) {
      setMessage("El nuevo PIN debe tener entre 4 y 8 números.");
      return;
    }

    const employeeName = getEmployeeDisplayName(resetPinEmployeeId, employees);
    const newPinHash = await hashPin(resetPinValue);

    if (testMode) {
      setEmployees((current) =>
        current.map((employee) =>
          employee.id === resetPinEmployeeId ? { ...employee, pin: newPinHash } : employee
        )
      );
      setResetPinEmployeeId("");
      setResetPinValue("");
      setMessage(`PIN de prueba restablecido para ${employeeName}.`);
      return;
    }

    setIsLoading(true);
    try {
      await supabaseRequest(`employees?id=eq.${resetPinEmployeeId}`, {
        method: "PATCH",
        body: JSON.stringify({ pin_hash: newPinHash }),
      });

      setEmployees((current) =>
        current.map((employee) =>
          employee.id === resetPinEmployeeId ? { ...employee, pin: newPinHash } : employee
        )
      );
      setResetPinEmployeeId("");
      setResetPinValue("");
      setMessage(`PIN restablecido para ${employeeName}.`);
    } catch (error) {
      setMessage(`Error restableciendo PIN: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function exportCSV() {
    const csv = buildCSV(filteredRecords);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fichajes-${getEmployeeDisplayName(selectedEmployeeId, employees)}-${filterDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function prepareDailyReport() {
    const selectedEmployeeName = selectedEmployee?.name || "Empleado";
    const generatedAt = new Date().toISOString();
    const signature = await buildReportSignature({
      type: "daily",
      employeeId: selectedEmployeeId,
      employeeName: selectedEmployeeName,
      period: filterDate,
      records: filteredRecords.map((record) => ({ id: record.id, type: record.record_type, effectiveType: record.effectiveType, at: record.createdAt, note: record.note || "" })),
      totals: dailySummary,
      generatedAt,
      generatedBy: adminName || "Admin",
    });
    const fullSignature = { ...signature, generatedAt: nowDateTime(new Date(generatedAt)), generatedBy: adminName || "Admin" };
    const summaryCards = [
      ["Trabajo bruto", formatMinutes(dailySummary.grossWorkMinutes)],
      ["Pausas", formatMinutes(dailySummary.breakMinutes)],
      ["Trabajo neto", formatMinutes(dailySummary.netWorkMinutes)],
      ["Ajustes", dailySummary.adjustmentCount],
    ];
    const tableHeaders = ["Empleado", "Tipo", "Hora", "Fecha", "Nota", "Creado por"];
    const tableRows = filteredRecords.map((record) => [record.employeeName, record.label, record.time, record.date, record.note || "", record.createdBy || "Sistema"]);
    const html = buildDailyReportHTML({
      employeeName: selectedEmployeeName,
      filterDate,
      dailySummary,
      filteredRecords,
      signature: fullSignature,
    });

    return {
      title: "Informe diario de fichaje",
      employeeName: selectedEmployeeName,
      periodLabel: filterDate,
      summaryCards,
      tableHeaders,
      tableRows,
      warnings: dailySummary.warnings,
      adjustmentRows: getManualAdjustmentRows(filteredRecords),
      signature: fullSignature,
      html,
      fileName: `informe-diario-${safeFileName(selectedEmployeeName)}-${filterDate}.pdf`,
    };
  }

  async function generateDailyReportPreview() {
    try {
      const report = await prepareDailyReport();
      setLastSignature(report.signature);
      setReportHTML(report.html);
      setShowReport(true);
      setShowRawHTML(false);
      setMessage(`Informe diario generado. Código de verificación: ${report.signature.shortCode}.`);
    } catch (error) {
      setMessage(`Error generando informe diario: ${error.message}`);
    }
  }

  async function downloadDailyPDF() {
    try {
      const report = await prepareDailyReport();
      const doc = buildPDFDocument(report);
      downloadPDFDocument(doc, report.fileName);
      setLastSignature(report.signature);
      setMessage(`PDF diario descargado. Código de verificación: ${report.signature.shortCode}.`);
    } catch (error) {
      setMessage(`Error descargando PDF diario: ${error.message}`);
    }
  }

  async function prepareMonthlyReport() {
    const selectedEmployeeName = selectedEmployee?.name || "Empleado";
    const generatedAt = new Date().toISOString();
    const signature = await buildReportSignature({
      type: "monthly",
      employeeId: selectedEmployeeId,
      employeeName: selectedEmployeeName,
      period: filterMonth,
      records: selectedEmployeeMonthRecords.map((record) => ({ id: record.id, type: record.record_type, effectiveType: record.effectiveType, at: record.createdAt, note: record.note || "" })),
      totals: monthlySummary.totals,
      generatedAt,
      generatedBy: adminName || "Admin",
    });
    const fullSignature = { ...signature, generatedAt: nowDateTime(new Date(generatedAt)), generatedBy: adminName || "Admin" };
    const rows = monthlySummary.days.map((day) => [
      day.date,
      formatMinutes(day.summary.netWorkMinutes),
      formatMinutes(day.summary.breakMinutes),
      day.summary.recordsCount,
      day.summary.adjustmentCount,
      day.summary.warnings.length ? day.summary.warnings.join(" · ") : "Sin incidencias",
    ]);
    const warnings = monthlySummary.days.flatMap((day) =>
      day.summary.warnings.map((warning) => `${day.date}: ${warning}`)
    );
    const summaryCards = [
      ["Trabajo bruto mensual", formatMinutes(monthlySummary.totals.grossWorkMinutes)],
      ["Pausas mensuales", formatMinutes(monthlySummary.totals.breakMinutes)],
      ["Trabajo neto mensual", formatMinutes(monthlySummary.totals.netWorkMinutes)],
      ["Ajustes", monthlySummary.totals.adjustmentCount],
    ];
    const tableHeaders = ["Día", "Trabajo neto", "Pausas", "Registros", "Ajustes", "Incidencias"];
    const html = buildMonthlyReportHTML({
      employeeName: selectedEmployeeName,
      monthISO: filterMonth,
      monthlySummary,
      signature: fullSignature,
    });

    return {
      title: "Informe mensual de fichaje",
      employeeName: selectedEmployeeName,
      periodLabel: getMonthLabel(filterMonth),
      summaryCards,
      tableHeaders,
      tableRows: rows,
      warnings,
      adjustmentRows: getManualAdjustmentRows(monthlySummary.days.flatMap((day) => day.records)),
      signature: fullSignature,
      html,
      fileName: `informe-mensual-${safeFileName(selectedEmployeeName)}-${filterMonth}.pdf`,
    };
  }

  async function generateMonthlyReportPreview() {
    try {
      const report = await prepareMonthlyReport();
      setLastSignature(report.signature);
      setReportHTML(report.html);
      setShowReport(true);
      setShowRawHTML(false);
      setMessage(`Informe mensual generado. Código de verificación: ${report.signature.shortCode}.`);
    } catch (error) {
      setMessage(`Error generando informe mensual: ${error.message}`);
    }
  }

  async function downloadMonthlyPDF() {
    try {
      const report = await prepareMonthlyReport();
      const doc = buildPDFDocument(report);
      downloadPDFDocument(doc, report.fileName);
      setLastSignature(report.signature);
      setMessage(`PDF mensual descargado. Código de verificación: ${report.signature.shortCode}.`);
    } catch (error) {
      setMessage(`Error descargando PDF mensual: ${error.message}`);
    }
  }

  function printReportPreview() {
    if (!reportHTML) {
      setMessage("Primero genera la vista previa del informe.");
      return;
    }

    setPrintMode(true);
    setMessage("Modo impresión activado. Si no aparece el diálogo, pulsa Ctrl+P y elige ‘Guardar como PDF’.");

    window.setTimeout(() => {
      try {
        window.print();
      } catch (error) {
        setMessage("No se pudo abrir impresión automáticamente. Pulsa Ctrl+P para guardar como PDF.");
      }
    }, 300);
  }

  function exitPrintMode() {
    setPrintMode(false);
    setMessage("Modo impresión desactivado.");
  }

  function selectRawHTML() {
    setShowRawHTML(true);
    window.setTimeout(() => {
      if (reportTextAreaRef.current) {
        reportTextAreaRef.current.focus();
        reportTextAreaRef.current.select();
        setMessage("HTML seleccionado. Pulsa Ctrl+C para copiarlo manualmente.");
      }
    }, 50);
  }

  function openReportInSameTab() {
    if (!reportHTML) {
      setMessage("Primero genera la vista previa del informe.");
      return;
    }

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(reportHTML)}`;
    window.location.href = dataUrl;
  }

  function unlockAdmin() {
    if ((adminPin === ADMIN_PIN || pin.trim() === ADMIN_PIN) && !selectedEmployeeId) {
      setIsAdminUnlocked(true);
      setViewMode("admin");
      setAdminPin("");
      setPin("");
      setMessage("Panel admin desbloqueado.");
      return;
    }

    setMessage("Código de administrador incorrecto. Para acceder: deja empleado sin seleccionar e introduce el código admin en el PIN.");
  }

  function handlePinChange(value) {
    setPin(value);
    if (!selectedEmployeeId && value.trim() === ADMIN_PIN) {
      setIsAdminUnlocked(true);
      setViewMode("admin");
      setPin("");
      setMessage("Panel admin desbloqueado.");
    }
  }

  function lockAdmin() {
    setIsAdminUnlocked(false);
    setViewMode("kiosk");
    setShowReport(false);
    setShowRawHTML(false);
    setPrintMode(false);
    setResetPinEmployeeId("");
    setMessage("Panel admin bloqueado. Modo kiosko activo.");
  }

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-900 md:p-8">
      <style>{`
        @media print {
          .app-screen { display: none !important; }
          .report-print-area { display: block !important; }
          body { background: white !important; }
        }
        @media screen {
          .report-print-area { display: ${printMode ? "block" : "none"}; }
          .app-screen { display: ${printMode ? "none" : "block"}; }
        }
      `}</style>

      {printMode && (
        <div className="report-print-area bg-white p-8" dangerouslySetInnerHTML={{ __html: reportHTML }} />
      )}

      <div className="app-screen mx-auto max-w-6xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-slate-500">Letras a la Taza</p>
            <h1 className="text-3xl font-bold">Control horario y fichaje</h1>
            <p className="mt-2 text-slate-600">
              {viewMode === "kiosk" ? "Modo kiosko para tablet de fichaje." : "Panel de administración."}
            </p>
            <p className="mt-1 text-xs font-bold text-emerald-700">Versión {APP_VERSION}</p>
            <p className="mt-1 text-xs font-bold text-emerald-700">Versión {APP_VERSION}</p>
          </div>

          <div className="flex flex-col gap-3 md:items-end">
            <div className="flex items-center gap-3 rounded-2xl bg-slate-100 px-4 py-3">
              <span className="text-2xl" aria-hidden="true">🕒</span>
              <div>
                <p className="text-xs text-slate-500">Ahora</p>
                <p className="text-lg font-semibold">{currentDateTime}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {isAdminUnlocked && (
                <Button onClick={() => setTestMode(!testMode)} variant="secondary">
                  {testMode ? "Salir modo prueba" : "Modo prueba"}
                </Button>
              )}

              

              {isAdminUnlocked && (
                <>
                  <Button onClick={() => setViewMode("kiosk")} variant={viewMode === "kiosk" ? "default" : "outline"}>
                    Kiosko
                  </Button>
                  <Button onClick={() => setViewMode("admin")} variant={viewMode === "admin" ? "default" : "outline"}>
                    Admin
                  </Button>
                  <Button onClick={lockAdmin} variant="secondary">Bloquear</Button>
                </>
              )}
            </div>
          </div>
        </header>

        {viewMode === "kiosk" && (
          <section className="mx-auto max-w-3xl">
            <Card className="rounded-3xl shadow-sm">
              <CardContent className="space-y-5 p-6">
                <div>
                  <h2 className="text-xl font-bold">Fichar turno</h2>
                  <p className="text-sm text-slate-500">Cada empleado ficha con su PIN personal.</p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-sm font-medium">Empleado</span>
                    <select
                      value={selectedEmployeeId}
                      onChange={(event) => setSelectedEmployeeId(event.target.value)}
                      className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                      disabled={isLoading || activeEmployees.length === 0}
                    >
                      {activeEmployees.length === 0 ? (
                        <option value="">Sin empleados activos</option>
                      ) : (
                        activeEmployees.map((employee) => (
                          <option key={employee.id} value={employee.id}>{employee.name}</option>
                        ))
                      )}
                    </select>
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium">PIN</span>
                    <input
                      type="password"
                      value={pin}
                      onChange={(event) => handlePinChange(event.target.value)}
                      placeholder="Introduce tu PIN"
                      className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                      disabled={isLoading}
                    />
                  </label>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-sm text-slate-500">Estado actual</p>
                  <p className="text-2xl font-bold">{currentStatus}</p>
                </div>

                <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Trabajo neto</p>
                    <p className="text-2xl font-bold">{formatMinutes(dailySummary.netWorkMinutes)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Pausas</p>
                    <p className="text-2xl font-bold">{formatMinutes(dailySummary.breakMinutes)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Registros del día</p>
                    <p className="text-2xl font-bold">{dailySummary.recordsCount}</p>
                  </div>
                </div>

                {dailySummary.warnings.length > 0 && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    <p className="mb-2 font-bold">Avisos del día</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {dailySummary.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid gap-3 md:grid-cols-4">
                  <Button onClick={() => addRecord("entrada")} className="rounded-2xl p-6 text-base" disabled={isLoading}>
                    <MiniIcon>↪</MiniIcon> Entrada
                  </Button>
                  <Button onClick={() => addRecord("pausa_inicio")} variant="secondary" className="rounded-2xl p-6 text-base" disabled={isLoading}>
                    <MiniIcon>☕</MiniIcon> Pausa
                  </Button>
                  <Button onClick={() => addRecord("pausa_fin")} variant="secondary" className="rounded-2xl p-6 text-base" disabled={isLoading}>
                    <MiniIcon>↩</MiniIcon> Volver
                  </Button>
                  <Button onClick={() => addRecord("salida")} variant="outline" className="rounded-2xl p-6 text-base" disabled={isLoading}>
                    <MiniIcon>⇥</MiniIcon> Salida
                  </Button>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm font-medium text-slate-700">
                  {isLoading ? "Trabajando... " : ""}{message}
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {viewMode === "admin" && isAdminUnlocked && (
          <>
            <Card className="rounded-3xl shadow-sm">
              <CardContent className="space-y-4 p-6">
                <div>
                  <h2 className="text-xl font-bold">Responsable y trazabilidad</h2>
                  <p className="text-sm text-slate-500">Este nombre se usará en ajustes manuales y en la firma de informes.</p>
                </div>
                <input
                  value={adminName}
                  onChange={(event) => setAdminName(event.target.value)}
                  placeholder="Nombre del responsable"
                  className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300 md:max-w-md"
                />
                {lastSignature && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    Última firma generada: <strong>{lastSignature.shortCode}</strong>
                  </div>
                )}
              </CardContent>
            </Card>
            <section className="grid gap-6 lg:grid-cols-[1fr_1fr]">
              <Card className="rounded-3xl shadow-sm">
                <CardContent className="space-y-5 p-6">
                  <div>
                    <h2 className="text-xl font-bold">Añadir empleado</h2>
                    <p className="text-sm text-slate-500">Se guarda directamente en Supabase.</p>
                  </div>

                  <input
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Nombre del empleado"
                    className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                    disabled={isLoading}
                  />
                  <input
                    value={newPin}
                    onChange={(event) => setNewPin(event.target.value)}
                    placeholder="PIN de fichaje"
                    className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                    disabled={isLoading}
                  />
                  <Button onClick={addEmployee} className="w-full rounded-2xl p-6 text-base" disabled={isLoading}>
                    <MiniIcon>＋</MiniIcon> Añadir empleado
                  </Button>
                </CardContent>
              </Card>

              <Card className="rounded-3xl shadow-sm">
                <CardContent className="space-y-5 p-6">
                  <div>
                    <h2 className="text-xl font-bold">Equipo registrado</h2>
                    <p className="text-sm text-slate-500">Pulsa un empleado para ver sus informes.</p>
                  </div>
                  <div className="space-y-2">
                    {activeEmployees.length === 0 ? (
                      <div className="rounded-xl bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">Todavía no hay empleados activos.</div>
                    ) : (
                      activeEmployees.map((employee) => (
                        <div
                          key={employee.id}
                          className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium shadow-sm ${selectedEmployeeId === employee.id ? "bg-slate-900 text-white" : "bg-slate-50 text-slate-900"}`}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedEmployeeId(employee.id)}
                            className="flex-1 text-left"
                          >
                            {employee.name}
                          </button>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => startResetPin(employee.id)}
                              className={`rounded-lg px-3 py-1 text-xs ${selectedEmployeeId === employee.id ? "bg-white/20 text-white" : "bg-blue-50 text-blue-700"}`}
                              disabled={isLoading}
                            >
                              Cambiar PIN
                            </button>
                            <button
                              type="button"
                              onClick={() => deactivateEmployee(employee.id)}
                              className={`rounded-lg px-3 py-1 text-xs ${selectedEmployeeId === employee.id ? "bg-white/20 text-white" : "bg-red-50 text-red-700"}`}
                              disabled={isLoading}
                            >
                              Dar de baja
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-700">Archivo de empleados dados de baja</h3>
                        <p className="mb-3 text-xs text-slate-500">No aparecen en el kiosko, pero se conservan para informes históricos.</p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-600">
                        {inactiveEmployees.length}
                      </span>
                    </div>

                    {inactiveEmployees.length === 0 ? (
                      <div className="rounded-xl bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
                        No hay empleados dados de baja.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {inactiveEmployees.map((employee) => (
                          <button
                            key={employee.id}
                            type="button"
                            onClick={() => setSelectedEmployeeId(employee.id)}
                            className={`w-full rounded-xl px-4 py-3 text-left text-sm font-medium shadow-sm ${selectedEmployeeId === employee.id ? "bg-slate-900 text-white" : "bg-white text-slate-600"}`}
                          >
                            {employee.name} · baja
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </section>

            {resetPinEmployeeId && (
              <Card className="rounded-3xl shadow-sm">
                <CardContent className="space-y-4 p-6">
                  <div>
                    <h2 className="text-xl font-bold">Restablecer PIN</h2>
                    <p className="text-sm text-slate-500">
                      Nuevo PIN para {getEmployeeDisplayName(resetPinEmployeeId, employees)}. El PIN anterior no se muestra ni se recupera.
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 md:flex-row">
                    <input
                      value={resetPinValue}
                      onChange={(event) => setResetPinValue(event.target.value)}
                      placeholder="Nuevo PIN, 4 a 8 números"
                      type="password"
                      className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300 md:max-w-sm"
                    />
                    <Button onClick={resetEmployeePin} disabled={isLoading} className="rounded-2xl">
                      Guardar nuevo PIN
                    </Button>
                    <Button onClick={() => { setResetPinEmployeeId(""); setResetPinValue(""); }} variant="secondary" className="rounded-2xl">
                      Cancelar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="rounded-3xl shadow-sm">
              <CardContent className="space-y-5 p-6">
                <div>
                  <h2 className="text-xl font-bold">Ajustes manuales</h2>
                  <p className="text-sm text-slate-500">Registrar incidencias sin modificar fichajes originales.</p>
                </div>

                <div className="grid gap-3 md:grid-cols-[190px_150px_130px_1fr_auto]">
                  <select
                    value={adjustType}
                    onChange={(event) => setAdjustType(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                  >
                    <option value="entrada">Entrada olvidada</option>
                    <option value="salida">Salida olvidada</option>
                    <option value="pausa_inicio">Pausa olvidada</option>
                    <option value="pausa_fin">Fin pausa olvidado</option>
                  </select>

                  <input
                    type="date"
                    value={adjustDate}
                    onChange={(event) => setAdjustDate(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                  />

                  <input
                    type="time"
                    value={adjustTime}
                    onChange={(event) => setAdjustTime(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                  />

                  <input
                    value={adjustNote}
                    onChange={(event) => setAdjustNote(event.target.value)}
                    placeholder="Motivo del ajuste"
                    className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                  />

                  <Button onClick={addAdjustment} className="rounded-2xl" disabled={isLoading}>
                    Registrar ajuste
                  </Button>
                </div>

                <p className="text-xs text-slate-500">
                  El ajuste se añade como registro nuevo, con fecha y hora propias. No modifica ni borra fichajes anteriores.
                </p>
              </CardContent>
            </Card>

            <Card className="rounded-3xl shadow-sm">
              <CardContent className="space-y-5 p-6">
                <div>
                  <h2 className="text-xl font-bold">Timeline del día</h2>
                  <p className="text-sm text-slate-500">Vista visual de la jornada del empleado seleccionado.</p>
                </div>

                {dayTimeline.length === 0 ? (
                  <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                    No hay registros para este empleado en la fecha seleccionada.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-3">
                      <div className="rounded-2xl bg-slate-50 px-4 py-3">
                        <p className="text-xs text-slate-500">Trabajo neto</p>
                        <p className="text-lg font-bold">{formatMinutes(dailySummary.netWorkMinutes)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 px-4 py-3">
                        <p className="text-xs text-slate-500">Pausas</p>
                        <p className="text-lg font-bold">{formatMinutes(dailySummary.breakMinutes)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 px-4 py-3">
                        <p className="text-xs text-slate-500">Ajustes</p>
                        <p className="text-lg font-bold">{dailySummary.adjustmentCount}</p>
                      </div>
                    </div>

                    {daySequenceIssues.length > 0 && (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        <p className="mb-2 font-bold">Avisos de secuencia</p>
                        <ul className="list-disc space-y-1 pl-5">
                          {daySequenceIssues.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="space-y-3">
                        {dayTimeline.map((item) => (
                          <div key={item.id} className="grid gap-3 md:grid-cols-[90px_1fr_150px] md:items-start">
                            <div className="text-sm font-bold text-slate-900">{item.record.time}</div>
                            <div className="relative rounded-2xl border border-slate-200 bg-slate-50 p-4">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <p className="font-bold">
                                    <span className="mr-2">{getRecordEmoji(item.record)}</span>
                                    {getRecordShortLabel(item.record)}
                                  </p>
                                  {item.record.note && (
                                    <p className="mt-1 text-sm text-slate-600">{item.record.note}</p>
                                  )}
                                </div>
                                {(item.record.record_type === "ajuste" || parseAdjustmentNote(item.record.note).isManualAdjustment) && (
                                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">
                                    manual
                                  </span>
                                )}
                              </div>
                              {item.next && (
                                <div className="mt-3 rounded-xl bg-white px-3 py-2 text-sm text-slate-600">
                                  {item.segmentLabel}: <strong>{formatMinutes(item.durationMinutes)}</strong> hasta {item.next.time}
                                </div>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 md:pt-4">
                              {item.next ? `Siguiente: ${getRecordShortLabel(item.next)}` : "Último registro"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-3xl shadow-sm">
              <CardContent className="space-y-5 p-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-xl font-bold">Historial de fichajes</h2>
                    <p className="text-sm text-slate-500">Datos leídos desde Supabase. Elige empleado, día o mes para generar informes.</p>
                    <label className="mt-3 block max-w-sm space-y-2">
                      <span className="text-sm font-medium">Empleado para informes</span>
                      <select
                        value={selectedEmployeeId}
                        onChange={(event) => setSelectedEmployeeId(event.target.value)}
                        className="w-full rounded-2xl border border-slate-200 bg-white p-3 outline-none focus:ring-2 focus:ring-slate-300"
                        disabled={isLoading || employees.length === 0}
                      >
                        {employees.length === 0 ? (
                          <option value="">Sin empleados</option>
                        ) : (
                          <>
                            {activeEmployees.length > 0 && (
                              <optgroup label="Empleados activos">
                                {activeEmployees.map((employee) => (
                                  <option key={employee.id} value={employee.id}>{employee.name}</option>
                                ))}
                              </optgroup>
                            )}

                            {inactiveEmployees.length > 0 && (
                              <optgroup label="Empleados dados de baja">
                                {inactiveEmployees.map((employee) => (
                                  <option key={employee.id} value={employee.id}>{employee.name} · baja</option>
                                ))}
                              </optgroup>
                            )}
                          </>
                        )}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-col gap-3 md:items-end">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
                        <span aria-hidden="true">📅</span>
                        <input
                          type="date"
                          value={filterDate}
                          onChange={(event) => setFilterDate(event.target.value)}
                          className="outline-none"
                        />
                      </label>
                      <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
                        <span aria-hidden="true">🗓️</span>
                        <input
                          type="month"
                          value={filterMonth}
                          onChange={(event) => setFilterMonth(event.target.value)}
                          className="outline-none"
                        />
                      </label>
                    </div>

                    <div className="grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <Button onClick={loadInitialData} variant="outline" className="rounded-2xl" disabled={isLoading || testMode}>
                        <MiniIcon>↻</MiniIcon> Recargar
                      </Button>
                      <Button onClick={exportCSV} variant="outline" className="rounded-2xl" disabled={isLoading}>
                        <MiniIcon>⬇</MiniIcon> CSV
                      </Button>
                      <Button onClick={generateDailyReportPreview} variant="outline" className="rounded-2xl" disabled={isLoading}>
                        <MiniIcon>📄</MiniIcon> Ver día
                      </Button>
                      <Button onClick={generateMonthlyReportPreview} variant="outline" className="rounded-2xl" disabled={isLoading}>
                        <MiniIcon>📚</MiniIcon> Ver mes
                      </Button>
                      <Button onClick={downloadDailyPDF} className="rounded-2xl" disabled={isLoading}>
                        <MiniIcon>⬇</MiniIcon> PDF día
                      </Button>
                      <Button onClick={downloadMonthlyPDF} className="rounded-2xl" disabled={isLoading}>
                        <MiniIcon>⬇</MiniIcon> PDF mes
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="p-4">Empleado</th>
                        <th className="p-4">Tipo</th>
                        <th className="p-4">Hora</th>
                        <th className="p-4">Fecha</th>
                        <th className="p-4">Nota</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecords.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="p-6 text-center text-slate-500">No hay fichajes para esta fecha.</td>
                        </tr>
                      ) : (
                        filteredRecords.map((record) => (
                          <tr key={record.id} className="border-t border-slate-100">
                            <td className="p-4 font-medium">{record.employeeName}</td>
                            <td className="p-4">{record.label}</td>
                            <td className="p-4">{record.time}</td>
                            <td className="p-4 text-slate-500">{record.date}</td>
                            <td className="p-4 text-slate-500">{record.note || "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {showReport && viewMode === "admin" && isAdminUnlocked && (
          <Card className="rounded-3xl shadow-sm">
            <CardContent className="space-y-4 p-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-bold">Vista previa del informe</h2>
                  <p className="text-sm text-slate-500">Si imprimir/descargar está bloqueado, usa “Ver HTML” y copia manualmente con Ctrl+C.</p>
                </div>
                <div className="flex flex-col gap-3 md:flex-row">
                  <Button onClick={printReportPreview} variant="outline" className="rounded-2xl">
                    <MiniIcon>🖨️</MiniIcon> Imprimir / PDF
                  </Button>
                  <Button onClick={openReportInSameTab} variant="outline" className="rounded-2xl">
                    <MiniIcon>↗</MiniIcon> Abrir informe
                  </Button>
                  <Button onClick={selectRawHTML} variant="outline" className="rounded-2xl">
                    <MiniIcon>📋</MiniIcon> Ver HTML
                  </Button>
                  <Button onClick={exitPrintMode} variant="secondary" className="rounded-2xl">
                    Salir modo impresión
                  </Button>
                  <Button onClick={() => setShowReport(false)} variant="secondary" className="rounded-2xl">
                    Cerrar
                  </Button>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <div
                  id="printable-report"
                  className="bg-white p-8"
                  dangerouslySetInnerHTML={{ __html: reportHTML }}
                />
              </div>

              {showRawHTML && (
                <div className="space-y-2">
                  <p className="text-sm text-slate-600">HTML seleccionable. Pulsa Ctrl+C para copiarlo y pégalo en un archivo .html o documento.</p>
                  <textarea
                    ref={reportTextAreaRef}
                    value={reportHTML}
                    readOnly
                    className="h-64 w-full rounded-2xl border border-slate-300 bg-white p-4 font-mono text-xs"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <AppFichajeEmpleados />
);
