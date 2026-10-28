import { useEffect, useRef } from "react";

/** Appelle `onConnected` à chaque passage de `connected` de faux à vrai.
 *
 * Le rappel passe par une ref : il vient d'`App`, qui le recrée à chaque
 * rendu, et le mettre dans les dépendances le rappellerait en boucle — le
 * rappel enregistre un récent, ce qui re-rend `App`, qui recrée le rappel. */
export function useConnectedSignal(connected: boolean, onConnected: (() => void) | undefined) {
  const callback = useRef(onConnected);
  useEffect(() => { callback.current = onConnected; }, [onConnected]);
  useEffect(() => {
    if (connected) callback.current?.();
  }, [connected]);
}
