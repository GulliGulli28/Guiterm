import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Le garde-fou de l'élévation, dans l'esprit de `hostPickers.test.ts` : un
// contrôle sur les sources, parce que rien d'autre ne peut le faire ici.
//
// C'est exactement la forme de panne qui a livré MongoDB inatteignable :
// backend complet (`sudo_session`, `sudo_pane`), commande enregistrée,
// binding `api.ts`, tests d'intégration verts — et le bouton jamais rendu, ou
// rendu sans être branché. Ni `tsc` ni les tests d'intégration Rust ne le
// verraient, et l'E2E ne peut pas ouvrir de panneau **distant** sur un runner
// (il n'y a aucun `sshd` en face), donc il ne peut vérifier que le refus sur
// un panneau local. Restent les sources.
//
// Ce que ce test ne fait PAS : prouver que le bouton est joli, ni qu'il est
// cliquable. Il pin le câblage — c'est le maillon qui a déjà cassé.

const source = readFileSync(fileURLToPath(new URL("../components/TransferTab.tsx", import.meta.url)), "utf8");

describe("bascule d'élévation du panneau de transfert", () => {
  it("est rendue, et repérable depuis un contrôle E2E", () => {
    // Le sélecteur qu'utilise `scripts/e2e-run.mjs` : le renommer sans
    // toucher au scénario ferait passer l'E2E pour de mauvaises raisons.
    expect(source).toContain("data-pane-elevate");
  });

  it("n'est offerte que sur un panneau SSH, et seulement une fois ouvert", () => {
    // Un panneau local est déjà la session de l'utilisateur (et Windows n'a
    // pas de `sudo`) ; un conteneur Docker ou un pod Kubernetes s'ouvre déjà
    // avec les droits de son `exec`. Proposer la bascule là serait un bouton
    // sans effet possible.
    expect(source).toMatch(/const canElevate = pane\.source\.kind === "remote"/);
    expect(source).toMatch(/\{canElevate && pane\.status === "open" && \(/);
  });

  it("appelle bien le backend, et pas seulement un état local", () => {
    // La bascule doit passer par la commande : la mettre à jour dans le
    // réducteur seul afficherait « root » sans rien élever du tout.
    expect(source).toMatch(/api\.setPaneElevated\(paneId, elevated, pane\.cwd, host\.label\)/);
    expect(source).toMatch(/apply\(\{ type: "elevation", side, elevated, result \}\)/);
    // Et la prop doit être passée au composant, sinon le bouton est inerte.
    expect(source).toMatch(/onSetElevated: setElevated/);
  });

  it("propose de rejouer l'action refusée, et pas d'élever le panneau", () => {
    // La moitié « proposée après un échec » de la fonctionnalité. Sans ce
    // routage, `reportPaneError` existerait mais toutes les erreurs
    // repartiraient en notification globale, et la bannière ne s'afficherait
    // jamais.
    expect(source).toMatch(/isPermissionDenied\(message\) && pane\.source\.kind === "remote" && !pane\.elevated/);
    // L'élévation porte sur l'action, pas sur le panneau : basculer le
    // panneau entier pour un fichier refusé est un bien plus gros geste, et
    // c'est précisément ce qui a été corrigé.
    expect(source).toContain("Réessayer en root");
    expect(source).not.toContain("Passer ce panneau en root");
    // Le rejeu doit vraiment redescendre après coup, sinon « en root » est un
    // synonyme de la bascule.
    expect(source).toMatch(/api\.setPaneElevated\(paneId, true,[\s\S]{0,400}pending\.retry\(\)[\s\S]{0,400}api\.setPaneElevated\(paneId, false,/);
    // Les actions d'un panneau doivent passer par `runPaneAction`, qui retient
    // de quoi les rejouer. Le compte n'a pas à être exact — ce qui compte est
    // qu'elles ne repartent pas toutes en notification globale.
    const routed = source.match(/runPaneAction\(\s*(?:side|destSide)\s*,/g) ?? [];
    expect(routed.length).toBeGreaterThanOrEqual(8);
  });
});
