// A small pulsing node that signals "working" — replaces the old spinner / "…"
// text everywhere. Blue (#82AAFF) to match the shared "active/working" status
// colour (see shell/agentStatus STATUS_COLOR.active).

export function WorkingNode({ size = 8 }: { size?: number }) {
  return (
    <span
      className="inline-block shrink-0 animate-pulse rounded-full"
      style={{
        width: size,
        height: size,
        background: "#82AAFF",
        boxShadow: "0 0 6px #82AAFF",
      }}
    />
  );
}
