export interface AppWebWorldOptions {
  place: "local" | "daytona" | "freestyle";
  ref?: string;
  lifetimeMinutes?: number;
}

export function parseAppWebOptions(argv: readonly string[], env: NodeJS.ProcessEnv): AppWebWorldOptions {
  const place = env.HARNESS_WORLD_PLACE ?? "local";
  if (place !== "local" && place !== "daytona" && place !== "freestyle") throw new Error("app-web supports only local, daytona, or freestyle placement.");
  let ref: string | undefined;
  let lifetimeMinutes = 120;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || seen.has(key)) throw new Error("Duplicate app-web option.");
    seen.add(key);
    if (key === "--ref" && value && /^[a-f0-9]{40}$/.test(value)) ref = value;
    else if (key === "--lifetime" && value && /^\d+$/.test(value) && Number(value) >= 10 && Number(value) <= 1430) lifetimeMinutes = Number(value);
    else throw new Error("app-web accepts --ref <full-pushed-sha> and --lifetime <10-1430 minutes> after --.");
  }
  if (place === "daytona" && !ref) throw new Error("Daytona app-web requires -- --ref <full-pushed-sha>.");
  if (place === "freestyle" && !ref) throw new Error("Freestyle app-web requires -- --ref <full-pushed-sha>.");
  if (place === "local" && ref) throw new Error("Local app-web uses this working tree; --ref is only supported on remote placements.");
  return { place, ref, lifetimeMinutes };
}
