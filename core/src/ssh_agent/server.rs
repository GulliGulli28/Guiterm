//! Où l'agent écoute : une socket Unix (Linux, macOS) dans un dossier privé à
//! l'utilisateur, un tube nommé sur Windows. Chaque client a sa connexion, et
//! sa [`Session`] — ce qu'il a annoncé de son serveur ne vaut que pour lui.
use super::{Agent, Client, Session, protocol};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Le nom du tube nommé Windows (à mettre dans `SSH_AUTH_SOCK`).
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\guiterm-ssh-agent";

/// Où l'agent écoute par défaut : `$XDG_RUNTIME_DIR/gui-termius/ssh-agent.sock`
/// sous Linux (effacé à la déconnexion de la session), le cache de l'app
/// ailleurs ; le tube `guiterm-ssh-agent` sous Windows.
pub fn default_endpoint() -> anyhow::Result<String> {
    #[cfg(windows)]
    {
        Ok(PIPE_NAME.to_string())
    }
    #[cfg(not(windows))]
    {
        let dirs = directories::ProjectDirs::from("dev", "gui-termius", "gui-termius")
            .ok_or_else(|| anyhow::anyhow!("impossible de déterminer le dossier de l'application"))?;
        let dir = dirs.runtime_dir().unwrap_or_else(|| dirs.cache_dir());
        Ok(dir.join("ssh-agent.sock").to_string_lossy().into_owned())
    }
}

/// L'agent en marche. Le lâcher l'arrête (et efface la socket).
pub struct Running {
    pub endpoint: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}

/// Répond aux trames d'un client jusqu'à ce qu'il raccroche.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, agent: Arc<Agent>, client: Client) {
    let mut session = Session { client, bindings: Vec::new() };
    let mut len = [0u8; 4];
    loop {
        if stream.read_exact(&mut len).await.is_err() {
            return;
        }
        let n = u32::from_be_bytes(len) as usize;
        if n == 0 || n > protocol::MAX_FRAME {
            return;
        }
        let mut payload = vec![0u8; n];
        if stream.read_exact(&mut payload).await.is_err() {
            return;
        }
        let reply = agent.handle(&payload, &mut session).await;
        if stream.write_all(&protocol::frame(&reply)).await.is_err() {
            return;
        }
    }
}

/// Démarre l'agent sur `endpoint` (chemin de socket, ou nom de tube sous
/// Windows).
#[cfg(unix)]
pub async fn start(endpoint: &str, agent: Arc<Agent>) -> anyhow::Result<Running> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    let path = std::path::PathBuf::from(endpoint);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        // Personne d'autre que l'utilisateur ne doit pouvoir y atteindre la
        // socket.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    if path.exists() {
        if UnixStream::connect(&path).await.is_ok() {
            anyhow::bail!("un autre agent écoute déjà sur {endpoint} (une autre instance de Guiterm ?)");
        }
        // Une socket laissée par une instance qui s'est mal arrêtée.
        std::fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path).map_err(|e| anyhow::anyhow!("impossible d'écouter sur {endpoint} : {e}"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let client = peer(&stream);
            tokio::spawn(serve(stream, agent.clone(), client));
        }
    });
    Ok(Running { endpoint: endpoint.to_string(), task })
}

/// Le processus au bout de la socket : son pid, et son nom — « git »,
/// « ssh », « scp »… — sous Linux (`/proc/<pid>/comm`) et macOS
/// (`proc_name`).
#[cfg(unix)]
fn peer(stream: &tokio::net::UnixStream) -> Client {
    let pid = stream.peer_cred().ok().and_then(|c| c.pid()).and_then(|p| u32::try_from(p).ok());
    #[cfg(target_os = "linux")]
    let program = pid.and_then(|p| std::fs::read_to_string(format!("/proc/{p}/comm")).ok()).map(|s| s.trim().to_string());
    #[cfg(target_os = "macos")]
    let program = pid.and_then(macos_program_name);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let program = None;
    Client { pid, program }
}

/// Le nom d'un processus sous macOS (`proc_name` de libproc, comme `ps -c`).
#[cfg(target_os = "macos")]
fn macos_program_name(pid: u32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: `buf` vit le temps de l'appel, et sa taille est celle passée ;
    // `proc_name` y écrit au plus autant d'octets et rend leur nombre.
    let n = unsafe { libc::proc_name(i32::try_from(pid).ok()?, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let n = usize::try_from(n).ok().filter(|n| *n > 0)?;
    let name = String::from_utf8_lossy(&buf[..n.min(buf.len())]).trim_end_matches('\0').trim().to_string();
    (!name.is_empty()).then_some(name)
}

#[cfg(windows)]
pub async fn start(endpoint: &str, agent: Arc<Agent>) -> anyhow::Result<Running> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = endpoint.to_string();
    // `first_pipe_instance` : si le tube existe déjà, c'est un autre agent —
    // on ne s'installe pas à côté. Les clients distants sont refusés
    // (défaut de tokio), et le descripteur de sécurité par défaut ne donne
    // l'écriture qu'à l'utilisateur et aux administrateurs.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&name)
        .map_err(|e| anyhow::anyhow!("impossible de créer le tube {name} (un autre agent l'occupe ?) : {e}"))?;
    let task = tokio::spawn(async move {
        loop {
            if server.connect().await.is_err() {
                continue;
            }
            let connected = server;
            server = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "agent SSH : impossible de rouvrir le tube, arrêt");
                    return;
                }
            };
            tokio::spawn(serve(connected, agent.clone(), Client::default()));
        }
    });
    Ok(Running { endpoint: endpoint.to_string(), task })
}
