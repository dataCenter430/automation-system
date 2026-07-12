/**
 * Parse a pasted blob into the six columns — WITHOUT writing anything.
 *
 * Deliberately separate from /api/tasks. The UI shows you the parsed fields to confirm
 * before any DB write, because a mis-split blob would otherwise poison a 45-minute build
 * that nobody notices until the task is nonsense.
 */
import { NextResponse } from "next/server";
import { parseTaskBlob, ParseError } from "../../../../../packages/shared/src/parse-task-blob.ts";
import { toTaskToml, TaxonomyError } from "../../../../../packages/shared/src/taxonomy.ts";
import { slugify } from "../../../../../packages/shared/src/slug.ts";

export async function POST(req: Request) {
  const { blob } = (await req.json()) as { blob?: string };
  if (!blob?.trim()) {
    return NextResponse.json({ error: "Paste the task text first." }, { status: 400 });
  }

  try {
    const parsed = parseTaskBlob(blob);
    const slug = slugify(parsed.title);

    // Resolve the closed vocabularies now, not at build time. An unknown label is a hard
    // error here, where you're looking at it — rather than a blocking CI failure an hour
    // into a build.
    let toml = null;
    let taxonomyError: string | null = null;
    try {
      toml = toTaskToml(parsed);
    } catch (e) {
      if (e instanceof TaxonomyError) taxonomyError = e.message;
      else throw e;
    }

    return NextResponse.json({ parsed, slug, toml, taxonomyError });
  } catch (e) {
    if (e instanceof ParseError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
