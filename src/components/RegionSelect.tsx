import { useState } from "react";
import { isKnownRegion, regionsByArea } from "../lib/awsRegions";

interface RegionSelectProps {
  value: string;
  onChange: (region: string) => void;
  className?: string;
}

/**
 * Picks an AWS region from the full list, without making the list a ceiling.
 *
 * AWS adds regions faster than this app ships, so a closed `<select>` would
 * eventually lock someone out of a region that exists. The escape hatch is an
 * "Autre…" entry that turns the control into a free-text field — and a value
 * this build doesn't know is kept and shown rather than silently reset to the
 * first option, which is what would happen to a region typed by a colleague or
 * carried in from `~/.aws/config`.
 */
export function RegionSelect({ value, onChange, className }: RegionSelectProps) {
  const [freeText, setFreeText] = useState(() => !!value && !isKnownRegion(value));

  if (freeText) {
    return (
      <div className="flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="eu-west-3"
          className={`${className ?? ""} font-mono`}
        />
        <button
          type="button"
          onClick={() => setFreeText(false)}
          title="Revenir à la liste"
          className="shrink-0 rounded px-1.5 py-1 text-[11px] text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
        >
          liste
        </button>
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === "__other") {
          setFreeText(true);
          onChange("");
          return;
        }
        onChange(e.target.value);
      }}
      className={className}
    >
      {/* Only while nothing is chosen: without it the control would *look*
          like the first region while the value behind it is still empty. */}
      {!value && <option value="">Choisir une région…</option>}
      {regionsByArea().map((group) => (
        <optgroup key={group.area} label={group.area}>
          {group.regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.id} — {region.label}
            </option>
          ))}
        </optgroup>
      ))}
      <option value="__other">Autre…</option>
    </select>
  );
}
