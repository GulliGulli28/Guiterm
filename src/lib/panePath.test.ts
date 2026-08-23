import { describe, expect, it } from "vitest";
import { baseName, breadcrumbs, cdCommand, joinPath, parentPath, pathSeparator } from "./panePath";

// Le bug réel : dans un panneau local sous Windows, « dossier parent » depuis
// `C:\Users\glorin` (le dossier d'ouverture) ne remontait pas d'un cran, il
// partait à `/` — la racine du disque — parce que la remontée cherchait un
// `/` dans un chemin qui n'en contient aucun.
describe("parentPath", () => {
  it("remonte d'un cran dans un chemin Windows", () => {
    expect(parentPath("C:\\Users\\glorin\\Documents")).toBe("C:\\Users\\glorin");
    expect(parentPath("C:\\Users\\glorin")).toBe("C:\\Users");
    expect(parentPath("C:\\Users")).toBe("C:\\");
  });

  it("remonte d'un cran dans un chemin POSIX", () => {
    expect(parentPath("/var/log/nginx")).toBe("/var/log");
    expect(parentPath("/var")).toBe("/");
  });

  it("ne remonte pas au-delà de la racine", () => {
    expect(parentPath("/")).toBe("/");
    expect(parentPath("C:\\")).toBe("C:\\");
    expect(parentPath("\\\\serveur\\partage")).toBe("\\\\serveur\\partage\\");
  });

  it("ignore un séparateur final", () => {
    expect(parentPath("/var/log/")).toBe("/var");
    expect(parentPath("C:\\Users\\glorin\\")).toBe("C:\\Users");
  });

  it("tolère un chemin Windows aux séparateurs mélangés", () => {
    // Ce que produisait l'ancien `joinPath`, qui ajoutait toujours un `/`.
    expect(parentPath("C:\\Users\\glorin/Documents")).toBe("C:\\Users\\glorin");
  });
});

describe("pathSeparator", () => {
  it("reconnaît un chemin Windows à sa lettre de lecteur, pas à la plateforme", () => {
    expect(pathSeparator("C:\\Users")).toBe("\\");
    expect(pathSeparator("D:/travail")).toBe("\\");
    expect(pathSeparator("\\\\serveur\\partage")).toBe("\\");
    // Un panneau SFTP ouvert depuis Windows reste en POSIX.
    expect(pathSeparator("/home/glorin")).toBe("/");
  });
});

describe("joinPath", () => {
  it("descend avec le séparateur du chemin, pas celui de la plateforme", () => {
    expect(joinPath("/var/log", "nginx")).toBe("/var/log/nginx");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("C:\\Users", "glorin")).toBe("C:\\Users\\glorin");
    expect(joinPath("C:\\", "Windows")).toBe("C:\\Windows");
  });
});

describe("breadcrumbs", () => {
  it("découpe un chemin POSIX en niveaux navigables", () => {
    expect(breadcrumbs("/var/log/nginx")).toEqual([
      { label: "/", path: "/" },
      { label: "var", path: "/var" },
      { label: "log", path: "/var/log" },
      { label: "nginx", path: "/var/log/nginx" },
    ]);
    expect(breadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("découpe un chemin Windows en partant du lecteur", () => {
    expect(breadcrumbs("C:\\Users\\glorin")).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "glorin", path: "C:\\Users\\glorin" },
    ]);
  });

  it("rend un chemin cliquable qui ramène exactement où il dit", () => {
    // La garantie qui compte : cliquer un niveau y va, pour n'importe quel
    // chemin — chaque `path` doit être un préfixe navigable réel.
    for (const path of ["/var/log/nginx", "C:\\Users\\glorin\\Documents", "/"]) {
      const crumbs = breadcrumbs(path);
      expect(crumbs[crumbs.length - 1].path).toBe(path);
      for (let i = 1; i < crumbs.length; i += 1) {
        expect(parentPath(crumbs[i].path)).toBe(crumbs[i - 1].path);
      }
    }
  });
});

describe("baseName", () => {
  it("rend le dernier segment", () => {
    expect(baseName("/var/log/nginx.conf")).toBe("nginx.conf");
    expect(baseName("C:\\Users\\glorin\\notes.txt")).toBe("notes.txt");
    expect(baseName("/var/log/")).toBe("log");
  });
});

describe("cdCommand", () => {
  it("protège un chemin POSIX en apostrophes", () => {
    expect(cdCommand("/var/log")).toBe("cd '/var/log'");
    // Une espace, un `$`, une apostrophe : le chemin doit arriver intact.
    expect(cdCommand("/srv/mes projets")).toBe("cd '/srv/mes projets'");
    expect(cdCommand("/srv/$HOME")).toBe("cd '/srv/$HOME'");
    expect(cdCommand("/srv/l'appli")).toBe("cd '/srv/l'\\''appli'");
  });

  it("utilise des guillemets doubles sous Windows, et /d seulement pour cmd", () => {
    expect(cdCommand("C:\\Users\\glorin")).toBe('cd "C:\\Users\\glorin"');
    expect(cdCommand("C:\\Users\\glorin", "powershell.exe")).toBe('cd "C:\\Users\\glorin"');
    // Sans /d, cmd ne change pas de lecteur.
    expect(cdCommand("D:\\travail", "C:\\Windows\\System32\\cmd.exe")).toBe('cd /d "D:\\travail"');
    expect(cdCommand("D:\\travail", "cmd")).toBe('cd /d "D:\\travail"');
  });
});
