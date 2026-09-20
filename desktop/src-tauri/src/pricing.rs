use crate::model::Event;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rate {
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub effective_from: Option<String>,
    pub input: f64,
    pub cached: f64,
    pub cache_write: f64,
    pub output: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prices {
    pub version: u32,
    pub currency: String,
    #[serde(default = "default_currency")]
    pub display_currency: String,
    #[serde(default)]
    pub usd_cny: Option<f64>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub aliases: BTreeMap<String, String>,
    pub models: BTreeMap<String, Vec<Rate>>,
}
fn default_currency() -> String { "USD".into() }
impl Prices {
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut p: Self = serde_json::from_str(text).map_err(|e| format!("价格JSON无效: {e}"))?;
        p.currency = p.currency.to_ascii_uppercase();
        p.display_currency = p.display_currency.to_ascii_uppercase();
        for rates in p.models.values_mut() {
            for rate in rates {
                if let Some(currency) = &mut rate.currency { *currency = currency.to_ascii_uppercase(); }
            }
        }
        if p.version != 1 || !["USD","CNY"].contains(&p.currency.as_str()) || !["USD","CNY"].contains(&p.display_currency.as_str()) {
            return Err("价格文件必须使用 version=1，currency 和 displayCurrency 仅支持 USD/CNY".into());
        }
        if p.usd_cny.is_some_and(|rate| !rate.is_finite() || rate <= 0.0) {
            return Err("usdCny 汇率必须大于零：表示 1 美元兑换多少人民币".into());
        }
        let mut needs_fx = p.currency == "CNY" || p.display_currency == "CNY";
        for (model, rates) in &p.models {
            if model.trim().is_empty() || rates.is_empty() {
                return Err("模型名和价格记录不能为空".into());
            }
            let mut dates = BTreeSet::new();
            for r in rates {
                if let Some(currency) = &r.currency {
                    if !["USD","CNY"].contains(&currency.as_str()) { return Err(format!("{model}: currency 仅支持 USD/CNY")); }
                    needs_fx |= currency == "CNY";
                }
                if [r.input, r.cached, r.cache_write, r.output]
                    .iter()
                    .any(|n| !n.is_finite() || *n < 0.0)
                {
                    return Err(format!("{model}: 价格必须是非负有限数"));
                }
                let ts = rate_time(r)?;
                if !dates.insert(ts) {
                    return Err(format!("{model}: 生效时间重复"));
                }
            }
        }
        if needs_fx && p.usd_cny.is_none() { return Err("人民币计价或显示需要先设置 usdCny 本地汇率（1 USD = ? CNY）".into()); }
        for (alias, dest) in &p.aliases {
            if alias.is_empty() || !p.models.contains_key(dest) {
                return Err(format!("别名 {alias} 必须直接指向已配置模型"));
            }
        }
        Ok(p)
    }
    pub fn cost(&self, e: &Event) -> Option<f64> {
        self.cost_parts(e).map(|parts|parts.iter().sum())
    }
    /// USD components in input, cache-read, cache-write, output order.
    pub fn cost_parts(&self, e: &Event) -> Option<[f64;4]> {
        let model = self.aliases.get(&e.model).unwrap_or(&e.model);
        let rate = self
            .models
            .get(model)?
            .iter()
            .filter(|r| rate_time(r).is_ok_and(|t| t <= e.ts))
            .max_by_key(|r| rate_time(r).unwrap_or(0))?;
        let t = &e.tokens;
        let factor = if rate.currency.as_deref().unwrap_or(&self.currency) == "CNY" { 1.0 / self.usd_cny? } else { 1.0 };
        Some([t.input as f64*rate.input/1_000_000.0,
            t.cached as f64*rate.cached/1_000_000.0,
            t.cache_write as f64*rate.cache_write/1_000_000.0,
            t.output as f64*rate.output/1_000_000.0].map(|cost|cost*factor))
    }
    pub fn display_factor(&self) -> f64 { if self.display_currency == "CNY" { self.usd_cny.unwrap_or(1.0) } else { 1.0 } }
}
fn rate_time(r: &Rate) -> Result<i64, String> {
    match &r.effective_from {
        None => Ok(0),
        Some(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|d| d.timestamp_millis())
            .map_err(|_| format!("无效生效时间: {s}；请包含时区")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Tokens;
    #[test]
    fn historical_prices_and_cache_are_independent() {
        let p=Prices::parse(r#"{"version":1,"currency":"USD","aliases":{"alias":"m"},"models":{"m":[{"input":1,"cached":0.1,"cacheWrite":2,"output":3},{"effectiveFrom":"2026-01-01T00:00:00Z","input":2,"cached":0.2,"cacheWrite":4,"output":6}]}}"#).unwrap();
        let mut e = Event {
            id: "1".into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: "alias".into(),
            ts: 1,
            tokens: Tokens {
                input: 1_000_000,
                cached: 1_000_000,
                cache_write: 1_000_000,
                output: 1_000_000,
                reasoning: 500_000,
            },
            path: "".into(),
            line: 1,
        };
        assert_eq!(p.cost(&e), Some(6.1));
        assert_eq!(p.cost_parts(&e),Some([1.0,0.1,2.0,3.0]));
        let first=e.clone();
        e.ts = 1_800_000_000_000;
        assert_eq!(p.cost(&e), Some(12.2));
        let summary=crate::query::summarize(&[first,e.clone()],&p);
        for (actual,expected) in summary.known_cost_by_component.iter().zip([3.0,0.3,6.0,9.0]) {
            assert!((actual-expected).abs()<1e-10);
        }
        assert!((summary.known_cost_usd-18.3).abs()<1e-10);
        e.model = "unknown".into();
        assert_eq!(p.cost(&e), None);
    }
    #[test]
    fn invalid_price_is_not_accepted() {
        assert!(Prices::parse(r#"{"version":1,"currency":"USD","models":{"m":[{"input":-1,"cached":0,"cacheWrite":0,"output":0}]}}"#).is_err());
    }
    #[test]
    fn mixed_currencies_normalize_before_aggregation_and_validate_exchange_rate() {
        let text=r#"{"version":1,"currency":"USD","displayCurrency":"CNY","usdCny":7,"models":{"domestic":[{"currency":"CNY","input":7,"cached":0.7,"cacheWrite":14,"output":21}],"foreign":[{"input":1,"cached":0.1,"cacheWrite":2,"output":3}]}}"#;
        let p=Prices::parse(text).unwrap();
        let mut e=Event{id:"1".into(),agent:"codex".into(),session:"s".into(),project:"p".into(),model:"domestic".into(),ts:1,tokens:Tokens{input:1_000_000,cached:1_000_000,cache_write:1_000_000,output:1_000_000,reasoning:500_000},path:String::new(),line:1};
        let domestic=p.cost(&e).unwrap();
        e.model="foreign".into();
        assert!((domestic-6.1).abs()<1e-10);
        assert!((p.cost(&e).unwrap()-domestic).abs()<1e-10);
        assert!((domestic*p.display_factor()-42.7).abs()<1e-10);
        let usd=Prices::parse(&text.replace("\"displayCurrency\":\"CNY\"","\"displayCurrency\":\"USD\"")).unwrap();
        assert_eq!(usd.display_factor(),1.0);
        assert!(Prices::parse(&text.replace("\"usdCny\":7,", "")).is_err());
        assert!(Prices::parse(&text.replace("\"usdCny\":7", "\"usdCny\":0")).is_err());
        assert!(Prices::parse(&text.replace("\"usdCny\":7", "\"usdCny\":-7")).is_err());
        assert!(Prices::parse(&text.replace("\"currency\":\"CNY\"", "\"currency\":\"EUR\"")).is_err());
    }
}
