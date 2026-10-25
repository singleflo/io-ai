// Change a session's working folder: attach it to another folder, relink a legacy link whose folder moved, or bring
// it back to its own workspace directory. Only `recipe.folder` changes: the recipe, overlay and files stay in the session dir.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ctx, saveRecipe, syncFolderMcp, type Session } from "./core";
import { linkFile, samePath, sessionFile, type Recipe } from "./workspace";

export type RelocateBody = { folder?: unknown; conversation?: unknown };
export type RelocateDeps = {
  park: (subtree: Session[]) => Promise<Map<Session, Recipe["desired"]>>;
  reconcile: () => Promise<void>;
};

const fail = (text: string, status = 400) => new Response(text, { status });
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

export async function relocate(s: Session, body: RelocateBody, deps: RelocateDeps): Promise<Response> {
  const conversation = body.conversation ?? "keep";
  if (conversation !== "keep" && conversation !== "new") return fail('conversation must be "keep" or "new"');
  const folder = body.folder === null ? null : typeof body.folder === "string" ? body.folder.trim() : undefined;
  if (folder === undefined) return fail("folder must be an existing absolute path");

  const recipe = s.recipe;
  if (!recipe) {
    // a legacy link whose project moved: point the link at the folder that holds the old recipe; the next scan migrates it
    if (s.recipeError?.startsWith("link target missing") && folder && existsSync(sessionFile(folder))) {
      mkdirSync(join(s.dir, ".orch"), { recursive: true });
      writeFileSync(linkFile(s.dir), `${JSON.stringify({ target: resolve(folder) }, null, 2)}\n`);
      await deps.reconcile();
      return Response.json({ ok: true });
    }
    return fail("no recipe at the new folder and the old one is missing");
  }
  if (s.state === "working" && s.proc) return fail("busy: the session is working", 409);

  if (folder === null) {
    if (!s.linked) return fail("the session already runs in its own folder");
  } else {
    if (!isAbsolute(folder) || !isDir(folder)) return fail("folder must be an existing absolute path");
    const rel = relative(resolve(ctx.ws), resolve(folder));
    if (!(rel.startsWith("..") || isAbsolute(rel))) return fail("folder inside the workspace does not need a link");
    if (s.linked && samePath(s.folder, folder)) return fail("the session already uses that folder");
  }

  const prev = await deps.park([s]);
  const old = s.linked ? s.folder : null;
  if (folder === null) delete recipe.folder;
  else recipe.folder = resolve(folder);
  recipe.mcpOwned = []; // those entries belong to the folder the session leaves
  if (conversation === "new") {
    if (recipe.sessionId) recipe.previousSessionIds.push(recipe.sessionId);
    recipe.sessionId = null;
  }
  for (const [x, d] of prev) if (x.recipe) x.recipe.desired = d; // parking only changed memory: save the real desired state
  saveRecipe(s);
  await deps.reconcile();
  if (old) syncFolderMcp(old); // the folder this session left keeps only what the remaining sharers need
  return Response.json({ ok: true });
}
