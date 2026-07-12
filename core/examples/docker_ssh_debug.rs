//! Standalone repro harness for the Docker-via-SSH-bastion "blank terminal"
//! bug — exercises exactly `docker::connect_for_host` + `docker::open_exec`
//! against the real workspace.json / OS keychain on this machine, with
//! verbose tracing, so the exec/attach flow can be iterated on without
//! rebuilding+relaunching the whole GUI app each time.
//!
//! Usage: `cargo run --example docker_ssh_debug -- <docker-host-id>`

use std::io::Write as _;
use termius_core::docker;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("debug"))
        .init();

    let host_id: termius_core::model::HostId = std::env::args()
        .nth(1)
        .expect("usage: docker_ssh_debug <docker-host-id>")
        .parse()
        .expect("host id must be a UUID");

    let workspace = termius_core::store::load()?;
    let host = workspace.host(host_id).expect("host not found in workspace.json").clone();
    println!("== host: {} (kind={:?}, via={:?})", host.label, host.kind, host.docker_via_host_id);

    println!("== connecting...");
    let client = docker::connect_for_host(&workspace, &host).await?;
    println!("== connected, listing containers...");
    let containers = docker::list_containers(&client).await?;
    for c in &containers {
        println!("  {} {} {} {}", c.id, c.name, c.image, c.state);
    }
    let target = containers
        .iter()
        .find(|c| c.state == "running")
        .or_else(|| containers.first())
        .expect("no containers found");
    println!("== opening exec in {} ({})...", target.name, target.id);

    let mut session = docker::open_exec(client, &target.id, 80, 24).await?;
    println!("== exec opened, reading for 5s while sending a newline every second...");

    let start = std::time::Instant::now();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                println!("== sending \"echo hi\\n\"");
                let _ = session.input.send(termius_core::ssh::ShellInput::Data(b"echo hi\n".to_vec())).await;
            }
            chunk = session.output.recv() => {
                match chunk {
                    Some(bytes) => {
                        print!("== got {} bytes: ", bytes.len());
                        std::io::stdout().write_all(&bytes)?;
                        println!();
                    }
                    None => {
                        println!("== output channel closed");
                        break;
                    }
                }
            }
        }
        if start.elapsed() > std::time::Duration::from_secs(8) {
            println!("== timeout reached, stopping");
            break;
        }
    }

    Ok(())
}
