import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/**
 * Les noms de comptes AWS, affichés tout de suite puis corrigés.
 *
 * Résoudre ces noms pour de vrai coûte un sous-processus `aws` par session
 * SSO, soit plusieurs secondes — et les trois panneaux qui les affichent
 * payaient ce délai à chaque montage, pour une donnée qui ne change
 * pratiquement jamais. Ici on peint depuis le cache disque (instantané), puis
 * on lance la vraie résolution en arrière-plan et on remplace quand elle
 * aboutit.
 *
 * Une table vide au tout premier lancement est normale : les panneaux
 * retombent sur l'id à douze chiffres, que le rafraîchissement remplace
 * quelques secondes plus tard.
 *
 * `refreshToken` — changer sa valeur relance les deux appels. Sert au panneau
 * Identités, qui se rafraîchit après une reconnexion SSO : c'est justement le
 * moment où des comptes jusque-là inaccessibles deviennent nommables.
 */
export function useAwsAccountNames(refreshToken?: number): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const freshRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    freshRef.current = false;

    // Le cache ne doit jamais écraser une résolution déjà revenue : les deux
    // appels partent ensemble, et rien ne garantit l'ordre d'arrivée.
    api.listAwsAccountNames()
      .then((cached) => {
        if (cancelled || freshRef.current || Object.keys(cached).length === 0) return;
        setNames(cached);
      })
      .catch(() => {});

    api.refreshAwsAccountNames()
      .then((fresh) => {
        if (cancelled) return;
        freshRef.current = true;
        // Un rafraîchissement vide (hors ligne, sessions expirées) laisse le
        // cache affiché plutôt que de repasser aux numéros de compte.
        if (Object.keys(fresh).length > 0) setNames(fresh);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [refreshToken]);

  return names;
}
