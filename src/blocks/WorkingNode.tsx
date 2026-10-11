// A small pulsing node that signals "working" — replaces the old spinner / "…"
// text everywhere. The shared "active/working" status colour (see
// shell/agentStatus STATUS_COLOR.active), adapted to the window: it is a blue
// chosen against black, and on a light theme it has to come down to be seen.

import { STATUS_COLOR } from "../shell/agentStatus";
import { useAdapt } from "../util/usePalette";

export function WorkingNode({ size = 8 }: { size?: number }) {
  const colour = useAdapt()(STATUS_COLOR.active, 2.2);
  return (
    <span
      className="inline-block shrink-0 animate-pulse rounded-full"
      style={{
        width: size,
        height: size,
        background: colour,
        boxShadow: `0 0 6px ${colour}`,
      }}
    />
  );
}
