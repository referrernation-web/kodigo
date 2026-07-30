const ESC = "\x1b[";
export const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export function paint(color, s) {
  return useColor ? `${c[color] || ""}${s}${c.reset}` : s;
}

export function printTool(name, input) {
  const summary = summarizeInput(name, input);
  process.stdout.write(`\n${paint("cyan", "⏺")} ${paint("bold", name)}${paint("gray", `(${summary})`)}\n`);
}

function summarizeInput(name, input) {
  if (!input) return "";
  const v =
    input.command ?? input.filePath ?? input.pattern ?? input.path ?? input.url ?? input.prompt ?? "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export function printDiff(filePath, oldStr, newStr) {
  process.stdout.write(paint("gray", `  ${filePath}\n`));
  const oldLines = String(oldStr).split("\n");
  const newLines = String(newStr).split("\n");
  for (const l of oldLines.slice(0, 12)) process.stdout.write(paint("red", `  - ${l}\n`));
  if (oldLines.length > 12) process.stdout.write(paint("gray", `  - …(${oldLines.length - 12} more)\n`));
  for (const l of newLines.slice(0, 12)) process.stdout.write(paint("green", `  + ${l}\n`));
  if (newLines.length > 12) process.stdout.write(paint("gray", `  + …(${newLines.length - 12} more)\n`));
}

export function renderMarkdown(text) {
  if (!useColor) return text;
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => paint("gray", `\n  ┌ ${lang}\n`) + code.split("\n").map(l => paint("gray", "  │ ") + l).join("\n") + paint("gray", "\n  └\n"))
    .replace(/^###### (.*)$/gm, (_, t) => paint("bold", t))
    .replace(/^##### (.*)$/gm, (_, t) => paint("bold", t))
    .replace(/^#### (.*)$/gm, (_, t) => paint("bold", t))
    .replace(/^### (.*)$/gm, (_, t) => paint("bold", paint("cyan", t)))
    .replace(/^## (.*)$/gm, (_, t) => paint("bold", paint("cyan", t)))
    .replace(/^# (.*)$/gm, (_, t) => paint("bold", paint("cyan", t)))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => paint("bold", t))
    .replace(/`([^`\n]+)`/g, (_, t) => paint("yellow", t));
}

export function spinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  if (!process.stdout.isTTY) return { stop() {} };
  const t = setInterval(() => {
    process.stdout.write(`\r${paint("cyan", frames[i++ % frames.length])} thinking…`);
  }, 80);
  return {
    stop() {
      clearInterval(t);
      process.stdout.write("\r" + " ".repeat(30) + "\r");
    },
  };
}
