/** Renders a unified-diff string with +/- line coloring (drives diff-preview-before-approval). */
export function DiffView({ unified }: { unified: string }) {
  const lines = unified.split("\n");
  return (
    <pre className="diff" aria-label="diff preview">
      {lines.map((line, i) => {
        const cls = line.startsWith("+")
          ? "diff-add"
          : line.startsWith("-")
            ? "diff-del"
            : line.startsWith("@@")
              ? "diff-hunk"
              : "diff-ctx";
        return (
          <div key={i} className={cls}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </pre>
  );
}
