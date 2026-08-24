import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Le garde-fou de la migration « liste plate → arborescence ».
//
// Chaque champ de sélection d'hôte de l'app affichait `workspace.hosts` à
// plat, dans l'ordre de stockage : ni dossiers, ni tags, et deux machines
// homonymes rangées ailleurs impossibles à départager. Onze champs ont été
// repris ; rien, dans les types ni dans le compilateur, n'empêche le douzième
// d'être écrit à plat — un `<select>` d'`<option>` compile parfaitement.
//
// D'où ces deux contrôles sur les sources, dans l'esprit de
// `accessibility.test.ts` : un détecteur (aucune liste d'hôtes ne repart en
// `<option>`) et un inventaire (les fichiers déjà repris le restent).

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function componentSources(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));
}

/**
 * Les `<option>` produits par une boucle sur une liste d'hôtes.
 *
 * Volontairement local plutôt que global : on regarde les 400 caractères qui
 * précèdent chaque `<option>` et on cherche un `.map(` sur quelque chose qui
 * s'appelle « …hosts ». Assez large pour attraper `workspace.hosts.map`,
 * `sshHosts.filter(…).map`, `props.hosts.map` ; assez étroit pour ne pas
 * signaler les `<option>` légitimes (moteurs SQL, périodes, types de tunnel).
 */
function flatHostOptions(source: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("<option", from);
    if (at === -1) return hits;
    from = at + 1;
    const window = source.slice(Math.max(0, at - 400), at);
    const mapAt = window.lastIndexOf(".map(");
    if (mapAt === -1) continue;
    // Ce sur quoi on itère : le bout d'expression juste avant `.map(`, une
    // fois les `.filter(…)`/`.sort(…)` intermédiaires ignorés.
    const iterated = window.slice(0, mapAt);
    if (/hosts\s*(?:\.(?:filter|sort|slice|concat)\([^]*)?$/i.test(iterated)) hits.push(at);
  }
}

describe("sélection d'hôtes", () => {
  it("ne remet aucune liste d'hôtes dans un <select> plat", () => {
    const offenders: string[] = [];
    for (const file of componentSources()) {
      const source = readFileSync(path.join(srcDir, file), "utf8");
      for (const at of flatHostOptions(source)) {
        offenders.push(`${file}:${source.slice(0, at).split("\n").length}`);
      }
    }
    expect(
      offenders,
      "ces champs listent des hôtes à plat : ni dossiers, ni tags — passer par "
      + `HostTreePicker (src/components/HostTreePicker.tsx) : ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  // Le contrôle anti-vacuité : un test de forme qui ne détecte plus rien reste
  // vert pour toujours. Celui-ci échoue si le détecteur ci-dessus cesse de
  // reconnaître exactement ce qu'il a servi à supprimer.
  it("détecte bien la forme qu'il interdit", () => {
    const regression = `
      <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
        <option value="">Tous les hôtes</option>
        {workspace.hosts.map((h) => (
          <option key={h.id} value={h.id}>{h.label}</option>
        ))}
      </select>`;
    // Deux `<option>` dans l'extrait, un seul produit par la boucle sur les
    // hôtes : c'est bien celui-là, et lui seul, qui est signalé.
    expect(flatHostOptions(regression)).toHaveLength(1);
    // Et il laisse tranquille une boucle qui n'est pas sur des hôtes.
    expect(flatHostOptions(`{PERIODS.map((p) => <option key={p.id}>{p.label}</option>)}`)).toEqual([]);
  });

  // L'inventaire. Ces fichiers portent un champ de sélection d'hôte : si l'un
  // d'eux cesse de passer par l'arborescence partagée, c'est qu'il est reparti
  // sur une liste maison — que le détecteur ci-dessus ne verrait pas s'il
  // n'utilise pas `<option>`.
  const HOST_PICKERS = [
    "components/ActivityTab.tsx",
    "components/DbTunnelPicker.tsx",
    "components/FleetTab.tsx",
    "components/HostForm.tsx",
    "components/KeychainPanel.tsx",
    "components/NetDiagTab.tsx",
    "components/RemoteSavePathPicker.tsx",
    "components/SplitPane.tsx",
    "components/SqlExportPanel.tsx",
    "components/SqliteRemoteFilePicker.tsx",
    "components/TransferTab.tsx",
    "components/TunnelsPanel.tsx",
  ];

  it("fait passer chaque champ de sélection d'hôte par l'arborescence partagée", () => {
    const missing = HOST_PICKERS.filter((f) => {
      const source = readFileSync(path.join(srcDir, f), "utf8");
      return !/from "\.\/(HostTreePicker|TargetTreeList)"/.test(source);
    });
    expect(
      missing,
      `ces fichiers choisissent un hôte sans l'arborescence partagée : ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lit bien les sources", () => {
    expect(componentSources().length).toBeGreaterThan(50);
  });
});
