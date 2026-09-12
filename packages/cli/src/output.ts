const supportsColor =
  process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

const ESC = "\u001b";

const wrap = (code: string) => (text: string) =>
  supportsColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");
export const cyan = wrap("36");

export const PASS = green("pass");
export const WARN = yellow("warn");
export const FAIL = red("fail");

export function line(label: string, status: string, detail?: string): void {
  console.log(`  ${label.padEnd(38, " ")} ${status}${detail ? `  ${dim(detail)}` : ""}`);
}

export function heading(text: string): void {
  console.log(`\n${bold(text)}`);
}
