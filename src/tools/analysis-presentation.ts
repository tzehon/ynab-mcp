import type { z } from "zod";
import type { outputSchema } from "./spending-analysis.js";
export type Analysis = z.infer<typeof outputSchema>;
export type Facts = Omit<
  Analysis,
  "evidence_digest" | "canonical_answer" | "charts"
>;
// Self-contained pure presentation shared by the server and private views.
// No provider reads, aggregation, persistent I/O or browser-dependent behavior.
export function presentationRuntime() {
  function fail(): never {
    throw new Error("SPENDING_ANALYSIS_INVALID");
  }
  function money(value: number) {
    if (!Number.isSafeInteger(value)) fail();
    const n = BigInt(value),
      absolute = n < 0n ? -n : n;
    const fraction = String(absolute % 1000n).padStart(3, "0");
    return `${n < 0n ? "-" : ""}${String(absolute / 1000n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.endsWith("0") ? fraction.slice(0, 2) : fraction}`;
  }
  function xml(value: string) {
    for (const char of value) {
      const n = char.codePointAt(0) ?? 0;
      if (
        (n < 32 && n !== 9 && n !== 10 && n !== 13) ||
        (n >= 0xd800 && n <= 0xdfff) ||
        n === 0xfffe ||
        n === 0xffff
      )
        fail();
    }
    return value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c] ?? c,
    );
  }
  type Row = { id: string; label: string; value: number };
  // Output is an inert, self-contained SVG. All financial labels use exact milliunits.
  // Scaling affects only bar geometry; zero remains visible and negative bars go left.
  function chartSvg(
    title: string,
    currency: string,
    rows: Row[],
    digest: string,
    caption = "",
    emptyMessage = "No category activity; reconciled zero.",
  ) {
    if (rows.length > 100) throw new Error("RESULT_TOO_LARGE");
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
    let y = 72;
    const captionText = (caption.match(/.{1,85}/gu) ?? [])
      .map((line) => {
        const text = `<text x="24" y="${y}">${xml(line)}</text>`;
        y += 20;
        return text;
      })
      .join("");
    y += 20;
    const body = rows
      .map((r) => {
        const lines = Array.from(r.label)
          .join("")
          .match(/.{1,70}/gu) ?? [r.label];
        const label = lines
          .map((line) => {
            const t = `<text x="24" y="${y}">${xml(line)}</text>`;
            y += 20;
            return t;
          })
          .join("");
        const value = `<text x="24" y="${y}" font-weight="bold">${xml(currency)} ${money(r.value)}</text>`;
        y += 10;
        const width = (Math.abs(r.value) / max) * 344;
        const bar = `<line x1="384" x2="384" y1="${y}" y2="${y + 16}" stroke="#687080"/><rect x="${r.value < 0 ? 384 - width : 384}" y="${y}" width="${width}" height="16" fill="${r.value < 0 ? "#8a4d9e" : "#176b91"}"/>`;
        y += 42;
        return `<g data-row-id="${xml(r.id)}" data-milliunits="${r.value}"><title>${xml(r.label)}: ${xml(currency)} ${money(r.value)}</title>${label}${value}${bar}</g>`;
      })
      .join("");
    if (rows.length === 0) y += 30;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 ${y + 28}" role="img" aria-label="${xml(title)}" data-evidence-digest="${digest}"><rect width="768" height="${y + 28}" fill="#fff"/><g fill="#17212b" font-family="sans-serif" font-size="16"><text x="24" y="28" font-size="20">${xml(title)}</text><text x="24" y="50">${xml(currency)} · net of category credits · zero at centre</text>${captionText}${body}${rows.length ? "" : `<text x="24" y="${y}">${xml(emptyMessage)}</text>`}</g></svg>`;
    if (new TextEncoder().encode(svg).length > 65536)
      throw new Error("RESULT_TOO_LARGE");
    return svg;
  }

  function present(facts: Facts, digest: string) {
    const cur = facts.currency_code;
    const { totals, comparison } = facts;
    let answer = `${facts.since_date} to ${facts.until_date} (${cur}). Net spending ${money(totals.net_spending_milliunits)} = gross category outflows ${money(totals.gross_outflow_milliunits)} less category credits ${money(totals.category_credit_milliunits)}. All ${facts.months.length} requested months reconciled. ${facts.all_periods_closed ? "Calendar periods closed; historical records may still change." : "Provisional: includes an open calendar period."} Income and credit-card payment bookkeeping excluded. Categorized tracking transfers included: ${money(totals.categorized_transfer_net_milliunits)}. Credits are not assumed to be refunds. Monthly snapshots are individually checked, not an atomic multi-month snapshot.`;
    if (comparison) {
      const p = comparison.percent_change_basis_points;
      const magnitude = p === null ? null : Math.abs(p);
      answer += ` ${comparison.month.slice(0, 7)} versus ${comparison.previous_month.slice(0, 7)}: ${comparison.direction}, change ${cur} ${money(comparison.change_milliunits)}${magnitude === null ? "; percentage unavailable for nonpositive baseline" : ` (${p !== null && p < 0 ? "-" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}% rounded to two decimals)`}. Category changes sum exactly to this change. These are observed category movements, not inferred purchase purposes.`;
    }
    const caption = `${facts.since_date} to ${facts.until_date} · Retrieved ${facts.as_of} · ${facts.all_periods_closed ? "Closed periods" : "Provisional open period"}`;
    const charts = [
      {
        kind: "monthly" as const,
        mime_type: "image/svg+xml" as const,
        svg: chartSvg(
          "Monthly net spending",
          cur,
          facts.months.map((m) => ({
            id: m.month,
            label: m.month.slice(0, 7),
            value: m.net_spending_milliunits,
          })),
          digest,
          caption,
        ),
      },
      {
        kind: "category" as const,
        mime_type: "image/svg+xml" as const,
        svg: chartSvg(
          "Period net spending by category",
          cur,
          facts.categories.map((c) => ({
            id: c.id,
            label: `${c.category_group_name} / ${c.name}`,
            value: c.net_spending_milliunits,
          })),
          digest,
          caption,
        ),
      },
    ];
    const resultCharts: Analysis["charts"] = charts;
    if (comparison)
      resultCharts.push({
        kind: "comparison",
        mime_type: "image/svg+xml",
        svg: chartSvg(
          `${comparison.month.slice(0, 7)} minus ${comparison.previous_month.slice(0, 7)} by category`,
          cur,
          comparison.category_changes.map((c) => ({
            id: c.id,
            label: c.name,
            value: c.change_milliunits,
          })),
          digest,
          caption,
          "No category changes; spending is unchanged.",
        ),
      });
    return { canonical_answer: answer, charts: resultCharts };
  }
  return { money, chartSvg, present };
}
