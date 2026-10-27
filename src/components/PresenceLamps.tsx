const STEPS = [
  { at: 8, name: "Quiet" },
  { at: 28, name: "Stirring" },
  { at: 50, name: "Restless" },
  { at: 70, name: "Angry" },
  { at: 88, name: "Possessed" },
];

export function presenceName(value: number): string {
  let name = "Quiet";
  for (const s of STEPS) if (value >= s.at) name = s.name;
  return name;
}

export function presenceBand(value: number): "low" | "mid" | "high" | "possessed" {
  if (value >= 88) return "possessed";
  if (value >= 70) return "high";
  if (value >= 28) return "mid";
  return "low";
}

export function PresenceLamps({ value }: { value: number }) {
  const name = presenceName(value);
  return (
    <div>
      <div className="lamps" role="meter" aria-label="Presence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={name}>
        {STEPS.map((s, i) => (
          <span key={s.name} className="lamp" data-lit={value >= s.at} data-danger={i === STEPS.length - 1} />
        ))}
      </div>
      <p className="mt-2 italic" style={{ color: "var(--ghost)" }}>
        {name}
      </p>
    </div>
  );
}
