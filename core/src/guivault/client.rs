//! Client HTTP de l'API GuiVault. Ne fait aucune cryptographie : il transporte
//! des blobs et des jetons. Le rafraîchissement du jeton d'accès est
//! transparent (un 401 → `/auth/refresh` → rejeu de la requête, une fois).
use guivault_protocol::*;
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// Le serveur a répondu avec un code d'erreur API (voir `docs/API.md`).
    #[error("{message}")]
    Api {
        status: StatusCode,
        code: String,
        message: String,
        /// Le corps complet, pour les codes qui portent plus (ex. `current`
        /// sur un `revision_mismatch`).
        body: serde_json::Value,
    },
    #[error("serveur injoignable : {0}")]
    Transport(#[from] reqwest::Error),
    #[error("session expirée, reconnexion nécessaire")]
    SessionExpired,
    #[error("réponse illisible : {0}")]
    Decode(String),
}

impl ClientError {
    pub fn code(&self) -> Option<&str> {
        match self {
            ClientError::Api { code, .. } => Some(code),
            _ => None,
        }
    }

    pub fn is_unauthorized(&self) -> bool {
        matches!(self, ClientError::Api { status, .. } if *status == StatusCode::UNAUTHORIZED)
            || matches!(self, ClientError::SessionExpired)
    }
}

pub type ClientResult<T> = Result<T, ClientError>;

/// Résultat d'une tentative de connexion.
pub enum LoginOutcome {
    Session(LoginResponse),
    TotpRequired(TotpChallenge),
}

/// Jetons courants, partagés entre appels : le rafraîchissement remplace la
/// paire en place, et [`Client::tokens`] permet de persister la nouvelle.
#[derive(Debug, Clone)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    tokens: Mutex<Option<Tokens>>,
}

impl Client {
    /// `server_url` sans `/api/v1` (ajouté ici), avec ou sans `/` final.
    pub fn new(server_url: &str, tokens: Option<Tokens>) -> ClientResult<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("Guiterm/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self {
            http,
            base: format!("{}/api/v1", server_url.trim_end_matches('/')),
            tokens: Mutex::new(tokens),
        })
    }

    pub fn tokens(&self) -> Option<Tokens> {
        self.tokens.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_tokens(&self, t: Option<Tokens>) {
        *self.tokens.lock().unwrap_or_else(|p| p.into_inner()) = t;
    }

    async fn decode<T: DeserializeOwned>(resp: reqwest::Response) -> ClientResult<T> {
        let status = resp.status();
        let bytes = resp.bytes().await?;
        if status.is_success() {
            if bytes.is_empty() {
                // `204` : on décode `()` via `null`.
                return serde_json::from_str("null").map_err(|e| ClientError::Decode(e.to_string()));
            }
            return serde_json::from_slice(&bytes).map_err(|e| ClientError::Decode(e.to_string()));
        }
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        let code = body["code"].as_str().unwrap_or("http_error").to_string();
        let message = body["message"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {status}"));
        Err(ClientError::Api {
            status,
            code,
            message,
            body,
        })
    }

    /// Requête sans jeton (prelogin, register, login, health).
    async fn public<T: DeserializeOwned, B: Serialize>(&self, method: Method, path: &str, body: Option<&B>) -> ClientResult<T> {
        let mut req = self.http.request(method, format!("{}{}", self.base, path));
        if let Some(b) = body {
            req = req.json(b);
        }
        Self::decode(req.send().await?).await
    }

    /// Requête authentifiée, avec un rafraîchissement transparent sur 401.
    async fn authed<T: DeserializeOwned, B: Serialize>(&self, method: Method, path: &str, body: Option<&B>) -> ClientResult<T> {
        for attempt in 0..2 {
            let access = self.tokens().ok_or(ClientError::SessionExpired)?.access;
            let mut req = self.http.request(method.clone(), format!("{}{}", self.base, path)).bearer_auth(access);
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await?;
            if resp.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                self.refresh().await?;
                continue;
            }
            return Self::decode(resp).await;
        }
        Err(ClientError::SessionExpired)
    }

    async fn refresh(&self) -> ClientResult<()> {
        let refresh = self.tokens().ok_or(ClientError::SessionExpired)?.refresh;
        let pair: TokenPair = self
            .public(Method::POST, "/auth/refresh", Some(&RefreshRequest { refresh_token: refresh }))
            .await
            .map_err(|e| if e.is_unauthorized() { ClientError::SessionExpired } else { e })?;
        self.set_tokens(Some(Tokens {
            access: pair.access_token,
            refresh: pair.refresh_token,
        }));
        Ok(())
    }

    const NO_BODY: Option<&()> = None;

    // ─── Santé et compte ─────────────────────────────────────────────────

    pub async fn health(&self) -> ClientResult<HealthResponse> {
        self.public(Method::GET, "/health", Self::NO_BODY).await
    }

    pub async fn prelogin(&self, email: &str) -> ClientResult<PreloginResponse> {
        self.public(Method::POST, "/auth/prelogin", Some(&PreloginRequest { email: email.into() })).await
    }

    pub async fn register(&self, req: &RegisterRequest) -> ClientResult<LoginResponse> {
        let resp: LoginResponse = self.public(Method::POST, "/auth/register", Some(req)).await?;
        self.set_tokens(Some(Tokens {
            access: resp.tokens.access_token.clone(),
            refresh: resp.tokens.refresh_token.clone(),
        }));
        Ok(resp)
    }

    /// `200` → session ; `202` → le mot de passe est bon mais un code TOTP
    /// est attendu (voir [`Client::totp_verify`]).
    pub async fn login(&self, req: &LoginRequest) -> ClientResult<LoginOutcome> {
        let resp = self.http.post(format!("{}/auth/login", self.base)).json(req).send().await?;
        if resp.status() == StatusCode::ACCEPTED {
            let challenge: TotpChallenge = Self::decode(resp).await?;
            return Ok(LoginOutcome::TotpRequired(challenge));
        }
        let resp: LoginResponse = Self::decode(resp).await?;
        self.adopt(&resp);
        Ok(LoginOutcome::Session(resp))
    }

    pub async fn totp_verify(&self, req: &TotpVerifyRequest) -> ClientResult<LoginResponse> {
        let resp: LoginResponse = self.public(Method::POST, "/auth/totp/verify", Some(req)).await?;
        self.adopt(&resp);
        Ok(resp)
    }

    fn adopt(&self, resp: &LoginResponse) {
        self.set_tokens(Some(Tokens {
            access: resp.tokens.access_token.clone(),
            refresh: resp.tokens.refresh_token.clone(),
        }));
    }

    pub async fn totp_status(&self) -> ClientResult<TotpStatus> {
        self.authed(Method::GET, "/auth/totp", Self::NO_BODY).await
    }

    pub async fn totp_setup(&self) -> ClientResult<TotpSetupResponse> {
        self.authed(Method::POST, "/auth/totp/setup", Self::NO_BODY).await
    }

    pub async fn totp_enable(&self, code: &str) -> ClientResult<TotpEnableResponse> {
        self.authed(Method::POST, "/auth/totp/enable", Some(&TotpCodeRequest { code: code.into() })).await
    }

    pub async fn totp_disable(&self, code: &str) -> ClientResult<()> {
        self.authed(Method::POST, "/auth/totp/disable", Some(&TotpCodeRequest { code: code.into() })).await
    }

    /// Ouvre le flux SSE et rend les événements un par un. Se termine quand
    /// le serveur ferme la connexion ; l'appelant se reconnecte.
    pub async fn events(&self) -> ClientResult<futures_util::stream::BoxStream<'static, ServerEvent>> {
        use futures_util::StreamExt;
        let access = self.tokens().ok_or(ClientError::SessionExpired)?.access;
        let resp = self
            .http
            .get(format!("{}/events", self.base))
            .bearer_auth(access)
            // Un flux n'a pas de fin : pas de délai global, seul le
            // keep-alive du serveur (30 s) dit s'il est vivant.
            .timeout(std::time::Duration::from_secs(3600 * 24))
            .send()
            .await?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            self.refresh().await?;
            return Err(ClientError::SessionExpired);
        }
        if !resp.status().is_success() {
            return Err(Self::decode::<()>(resp).await.expect_err("statut non 2xx"));
        }
        let mut buf = String::new();
        let stream = resp.bytes_stream().filter_map(move |chunk| {
            let out: Option<Vec<ServerEvent>> = match chunk {
                Ok(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    let mut events = Vec::new();
                    while let Some(pos) = buf.find("\n\n") {
                        let block = buf[..pos].to_string();
                        buf.replace_range(..pos + 2, "");
                        if let Some(data) = block.lines().find_map(|l| l.strip_prefix("data:"))
                            && let Ok(ev) = serde_json::from_str::<ServerEvent>(data.trim())
                        {
                            events.push(ev);
                        }
                    }
                    Some(events)
                }
                Err(_) => None,
            };
            async move { out }
        });
        Ok(stream.flat_map(futures_util::stream::iter).boxed())
    }

    pub async fn logout(&self) -> ClientResult<()> {
        self.authed(Method::POST, "/auth/logout", Self::NO_BODY).await
    }

    pub async fn change_password(&self, req: &ChangePasswordRequest) -> ClientResult<()> {
        self.authed(Method::POST, "/auth/password", Some(req)).await
    }

    pub async fn sessions(&self) -> ClientResult<Vec<Session>> {
        self.authed(Method::GET, "/auth/sessions", Self::NO_BODY).await
    }

    pub async fn revoke_session(&self, id: Uuid) -> ClientResult<()> {
        self.authed(Method::DELETE, &format!("/auth/sessions/{id}"), Self::NO_BODY).await
    }

    pub async fn me(&self) -> ClientResult<UserProfile> {
        self.authed(Method::GET, "/users/me", Self::NO_BODY).await
    }

    pub async fn lookup_user(&self, email: &str) -> ClientResult<UserLookupResponse> {
        let q = url::form_urlencoded::Serializer::new(String::new()).append_pair("email", email).finish();
        self.authed(Method::GET, &format!("/users/lookup?{q}"), Self::NO_BODY).await
    }

    pub async fn sync(&self) -> ClientResult<SyncResponse> {
        self.authed(Method::GET, "/sync", Self::NO_BODY).await
    }

    // ─── Vaults ──────────────────────────────────────────────────────────

    pub async fn create_vault(&self, req: &CreateVaultRequest) -> ClientResult<Vault> {
        self.authed(Method::POST, "/vaults", Some(req)).await
    }

    pub async fn rename_vault(&self, id: Uuid, req: &RenameVaultRequest) -> ClientResult<Vault> {
        self.authed(Method::PATCH, &format!("/vaults/{id}"), Some(req)).await
    }

    pub async fn delete_vault(&self, id: Uuid) -> ClientResult<()> {
        self.authed(Method::DELETE, &format!("/vaults/{id}"), Self::NO_BODY).await
    }

    pub async fn leave_vault(&self, id: Uuid) -> ClientResult<()> {
        self.authed(Method::POST, &format!("/vaults/{id}/leave"), Self::NO_BODY).await
    }

    pub async fn rotate_vault_key(&self, id: Uuid, req: &RotateVaultKeyRequest) -> ClientResult<Vault> {
        self.authed(Method::POST, &format!("/vaults/{id}/rotate-key"), Some(req)).await
    }

    pub async fn vault_audit(&self, id: Uuid, limit: u32) -> ClientResult<serde_json::Value> {
        self.authed(Method::GET, &format!("/vaults/{id}/audit?limit={limit}"), Self::NO_BODY).await
    }

    pub async fn members(&self, vault: Uuid) -> ClientResult<Vec<VaultMember>> {
        self.authed(Method::GET, &format!("/vaults/{vault}/members"), Self::NO_BODY).await
    }

    pub async fn update_member(&self, vault: Uuid, user: Uuid, role: Role) -> ClientResult<()> {
        self.authed(
            Method::PATCH,
            &format!("/vaults/{vault}/members/{user}"),
            Some(&UpdateMemberRequest { role }),
        )
        .await
    }

    pub async fn remove_member(&self, vault: Uuid, user: Uuid) -> ClientResult<()> {
        self.authed(Method::DELETE, &format!("/vaults/{vault}/members/{user}"), Self::NO_BODY).await
    }

    pub async fn transfer_ownership(&self, vault: Uuid, user: Uuid) -> ClientResult<()> {
        self.authed(Method::POST, &format!("/vaults/{vault}/members/{user}/transfer"), Self::NO_BODY).await
    }

    // ─── Invitations ─────────────────────────────────────────────────────

    pub async fn create_invitation(&self, vault: Uuid, req: &CreateInvitationRequest) -> ClientResult<Invitation> {
        self.authed(Method::POST, &format!("/vaults/{vault}/invitations"), Some(req)).await
    }

    pub async fn vault_invitations(&self, vault: Uuid) -> ClientResult<Vec<Invitation>> {
        self.authed(Method::GET, &format!("/vaults/{vault}/invitations"), Self::NO_BODY).await
    }

    pub async fn my_invitations(&self) -> ClientResult<Vec<Invitation>> {
        self.authed(Method::GET, "/invitations", Self::NO_BODY).await
    }

    pub async fn revoke_invitation(&self, id: Uuid) -> ClientResult<()> {
        self.authed(Method::DELETE, &format!("/invitations/{id}"), Self::NO_BODY).await
    }

    pub async fn accept_invitation(&self, id: Uuid) -> ClientResult<Invitation> {
        self.authed(Method::POST, &format!("/invitations/{id}/accept"), Self::NO_BODY).await
    }

    pub async fn decline_invitation(&self, id: Uuid) -> ClientResult<()> {
        self.authed(Method::POST, &format!("/invitations/{id}/decline"), Self::NO_BODY).await
    }

    pub async fn complete_invitation(&self, id: Uuid, req: &CompleteInvitationRequest) -> ClientResult<Invitation> {
        self.authed(Method::POST, &format!("/invitations/{id}/complete"), Some(req)).await
    }

    // ─── Items ───────────────────────────────────────────────────────────

    pub async fn items(&self, vault: Uuid, since: Option<i64>) -> ClientResult<ItemsPage> {
        let path = match since {
            Some(s) => format!("/vaults/{vault}/items?since={s}"),
            None => format!("/vaults/{vault}/items"),
        };
        self.authed(Method::GET, &path, Self::NO_BODY).await
    }

    pub async fn put_item(&self, vault: Uuid, item: Uuid, req: &PutItemRequest) -> ClientResult<Item> {
        self.authed(Method::PUT, &format!("/vaults/{vault}/items/{item}"), Some(req)).await
    }

    pub async fn delete_item(&self, vault: Uuid, item: Uuid) -> ClientResult<()> {
        self.authed(Method::DELETE, &format!("/vaults/{vault}/items/{item}"), Self::NO_BODY).await
    }
}
