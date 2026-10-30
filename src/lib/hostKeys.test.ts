import { describe, expect, it } from "vitest";
import { keyTypeOf, openSshFingerprint } from "./hostKeys";

// Clé et empreinte produites par `ssh-keygen` lui-même (`ssh-keygen -lf`) :
// c'est contre lui qu'on compare, pas contre notre propre calcul.
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII+LsKDMyLgcI1b+gAsnca2gfRLVZEMTZTb9qkG87uMu test";
const FINGERPRINT = "SHA256:MYC7Y9XpaKt5XCd/0sm8Q7bX7PmEXG7TvH7cY7QEr+w";

describe("hostKeys", () => {
  it("calcule l'empreinte que ssh-keygen affiche", async () => {
    expect(await openSshFingerprint(KEY)).toBe(FINGERPRINT);
  });

  it("refuse une ligne sans blob", async () => {
    expect(await openSshFingerprint("ssh-ed25519")).toBeNull();
    expect(await openSshFingerprint("ssh-ed25519 !!pas-du-base64!!")).toBeNull();
  });

  it("nomme le type comme à l'écran", () => {
    expect(keyTypeOf(KEY)).toBe("ed25519");
    expect(keyTypeOf("ssh-rsa AAAA")).toBe("RSA");
    expect(keyTypeOf("ecdsa-sha2-nistp256 AAAA")).toBe("ECDSA");
  });
});
