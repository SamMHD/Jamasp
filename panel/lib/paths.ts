import path from "node:path";

export const JAMASP_ROOT = process.env.JAMASP_ROOT
  ? path.resolve(process.env.JAMASP_ROOT)
  : path.resolve(process.cwd(), "..");
export const STATE_DIR = path.join(JAMASP_ROOT, "state");
export const DB_PATH = path.join(STATE_DIR, "jamasp.db");
export const REPORTS_DIR = path.join(JAMASP_ROOT, "reports");
export const CONFIG_DIR = path.join(JAMASP_ROOT, "config");
