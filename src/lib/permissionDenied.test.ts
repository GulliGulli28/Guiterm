import { describe, expect, it } from "vitest";
import { isPermissionDenied } from "./permissionDenied";

describe("isPermissionDenied", () => {
  /** Les messages réellement observés, un par backend du panneau de
   * transfert. Chacun doit déclencher la proposition d'élévation — c'est le
   * seul moment où l'utilisateur bloqué a besoin qu'on la lui offre. */
  it("reconnaît le refus de chacun des backends", () => {
    const observed = [
      // SFTP, tel que `russh-sftp` le rend.
      "Permission denied: Permission denied",
      // `sh` distant relayé par `pane_ops`, serveur en anglais.
      "commande distante en échec (code Some(1)) : du: cannot read directory '/var/log/private': Permission denied",
      // Le même, serveur en français.
      "commande distante en échec (code Some(1)) : find: '/root': Permission non accordée",
      // Panneau local sous Windows.
      "Accès refusé. (os error 5)",
      // Une couche qui ne traduit rien.
      "os error 13: EACCES",
      // Notre shell élevé enveloppant un refus.
      "commande élevée en échec (code 1) : cp: cannot open '/etc/shadow': Permission denied",
    ];
    for (const message of observed) {
      expect(isPermissionDenied(message), message).toBe(true);
    }
  });

  /** L'autre moitié du contrat : ne pas proposer sudo pour une erreur que
   * sudo ne réglerait pas. Un bouton qui apparaît à tort finit par être
   * cliqué à tort. */
  it("ne confond pas un refus avec les autres échecs", () => {
    const unrelated = [
      "Dossier « /tmp/absent » introuvable",
      "No such file or directory",
      "commande distante en échec (code Some(2)) : tar: /data: Cannot stat: No such file or directory",
      "transfert annulé",
      "la connexion a été perdue",
      "l'espace disque est insuffisant sur l'hôte",
      "",
    ];
    for (const message of unrelated) {
      expect(isPermissionDenied(message), message).toBe(false);
    }
  });

  /** `onError` reçoit ce que `catch` lui donne, qui n'est pas toujours une
   * chaîne : une commande Tauri rejette avec la valeur brute de son `Err`. */
  it("accepte autre chose qu'une chaîne sans exploser", () => {
    expect(isPermissionDenied(new Error("Permission denied"))).toBe(true);
    expect(isPermissionDenied(undefined)).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
    expect(isPermissionDenied({ message: "Permission denied" })).toBe(false);
  });
});
