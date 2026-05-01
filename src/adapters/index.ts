export {
  getAdapter,
  hasAdapter,
  listAdapters,
  registerAdapter,
} from "./registry"
export type {
  Adapter,
  FsOp,
  FsParsed,
  HttpParsed,
  ParsedAction,
  RawParsed,
  ShellParsed,
  SqlDdlOp,
  SqlKind,
  SqlParsed,
} from "./types"

import "./raw"
import "./sql"
import "./http"
import "./shell"
import "./fs"
