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
        // #76：校验此前只看别名的目标，不看别名的键。键与某个真实模型同名时，
        // cost_parts 先查 aliases：事件计费会路由到别名目标，而价目表按 models
        // 展示该模型自身的单价——两处数字静默背离。归一（去首尾空白+小写）后
        // 同名即冲突，保存时必须报错；唯一例外是恒等别名（X→X），路由结果就是
        // 模型自身价格，不构成背离。
        let priced: BTreeSet<String> = p.models.keys().map(|name| lexical_key(name)).collect();
        for (alias, dest) in &p.aliases {
            let (key, target) = (lexical_key(alias), lexical_key(dest));
            if key != target && priced.contains(&key) {
                return Err(format!("别名 {alias} 与已配置模型同名：计费会路由到 {dest}，价目表展示的却是该模型自身的单价，两处必然背离；请删除这条别名或这个模型条目"));
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
/// #76/#78 共用词法：键比较一律先去首尾空白、再小写（与采集侧模型名归一同一条规则）。
fn lexical_key(value: &str) -> String {
    value.trim().to_lowercase()
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
    /// #76 黄金数：glm-4 自身单价 input=2/百万，glm-3 input=1/百万。事件
    /// 1,000,000 input 走别名 {GLM-4→glm-3} 时成本=1.0，而价目表展示 glm-4 行
    /// 的单价算出来是 2.0——修前这种背离能保存成功。归一后同名（含大小写/空白
    /// 变体）必须保存即报错；恒等别名路由回自身单价 2.0，不构成背离。
    #[test]
    fn alias_key_shadowing_a_priced_model_is_rejected() {
        let rates = r#"[{"input":2,"cached":0,"cacheWrite":0,"output":0}]"#;
        let make = |aliases: &str| {
            format!(r#"{{"version":1,"currency":"USD","aliases":{aliases},"models":{{"glm-4":{rates},"glm-3":[{{"input":1,"cached":0,"cacheWrite":0,"output":0}}]}}}}"#)
        };
        let event = |model: &str| Event {
            id: "1".into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: model.into(),
            ts: 1,
            tokens: Tokens { input: 1_000_000, ..Default::default() },
            path: String::new(),
            line: 1,
        };
        // 修前：能保存，且 1.0 ≠ 价目表展示的 2.0，两处静默背离。
        let shadowing = Prices::parse(&make(r#"{"glm-4":"glm-3"}"#));
        assert!(shadowing.is_err(), "{shadowing:?}");
        assert!(shadowing.unwrap_err().contains("glm-4"));
        // 大小写变体同样顶掉真实模型，也报错。
        assert!(Prices::parse(&make(r#"{"GLM-4":"glm-3"}"#)).is_err());
        // 恒等别名不背离：路由回自身，按 2/百万 = 2.0 计费。
        let identity = Prices::parse(&make(r#"{"glm-4":"glm-4"}"#)).unwrap();
        assert_eq!(identity.cost(&event("glm-4")), Some(2.0));
        // 正常别名不受影响：stealth→glm-3，1M input 按 glm-3 的 1/百万 = 1.0。
        let routed = Prices::parse(&make(r#"{"stealth":"glm-3"}"#)).unwrap();
        assert_eq!(routed.cost(&event("stealth")), Some(1.0));
        assert_eq!(routed.cost(&event("glm-4")), Some(2.0));
    }
    /// #83 卫生项的守护：价目表里出现结构之外的字段必须保存即报错，而不是被
    /// 静默丢出文件（deny_unknown_fields 一旦回退，用户手写的字段会在下一次保存
    /// 后无声消失）。
    #[test]
    fn unknown_fields_are_rejected_not_silently_dropped() {
        let top = Prices::parse(r#"{"version":1,"currency":"USD","models":{},"note":"手写的备注"}"#);
        assert!(top.is_err(), "{top:?}");
        let rate = Prices::parse(r#"{"version":1,"currency":"USD","models":{"m":[{"input":1,"cached":0,"cacheWrite":0,"output":0,"reasoning":1}]}}"#);
        assert!(rate.is_err(), "{rate:?}");
    }
    /// #76 补覆盖：同一模型出现两条相同生效时间必须保存即报错。此前唯一的
    /// 历史价夹具是"基础价 + 一条带日期"（两个不同的 rate_time），重复分支从未
    /// 被喂过——把 `dates.insert` 的检查删掉没有任何测试会变红。
    #[test]
    fn duplicate_effective_from_for_one_model_is_rejected() {
        let rate = |from: &str| {
            format!(r#"{{"effectiveFrom":"{from}","input":1,"cached":0,"cacheWrite":0,"output":1}}"#)
        };
        let make = |rates: &str| {
            format!(r#"{{"version":1,"currency":"USD","models":{{"m":{rates}}}}}"#)
        };
        let err = Prices::parse(&make(&format!(
            "[{},{}]",
            rate("2026-01-01T00:00:00Z"),
            rate("2026-01-01T00:00:00Z")
        )))
        .unwrap_err();
        assert_eq!(err, "m: 生效时间重复");
        // 同一个瞬间写成不同时区偏移同样是重复（rate_time 比的是 epoch 毫秒）。
        assert_eq!(
            Prices::parse(&make(&format!(
                "[{},{}]",
                rate("2026-01-01T00:00:00Z"),
                rate("2026-01-01T08:00:00+08:00")
            )))
            .unwrap_err(),
            "m: 生效时间重复"
        );
        // 两条都没写 effectiveFrom = 两个基础价，同样是重复（手写文件最常见）。
        assert_eq!(
            Prices::parse(&make(
                r#"[{"input":1,"cached":0,"cacheWrite":0,"output":1},{"input":2,"cached":0,"cacheWrite":0,"output":2}]"#
            ))
            .unwrap_err(),
            "m: 生效时间重复"
        );
        // 非空跑对照：同一模型、两个不同生效时间必须解析成功，否则上面三条
        // 断言会因为任何别的原因报错也算通过。
        assert!(Prices::parse(&make(&format!(
            "[{},{}]",
            rate("2026-01-01T00:00:00Z"),
            rate("2026-02-01T00:00:00Z")
        )))
        .is_ok());
        // 重复是按模型分组判定的：两个模型各自用同一天不算冲突。
        assert!(Prices::parse(
            r#"{"version":1,"currency":"USD","models":{"a":[{"effectiveFrom":"2026-01-01T00:00:00Z","input":1,"cached":0,"cacheWrite":0,"output":1}],"b":[{"effectiveFrom":"2026-01-01T00:00:00Z","input":1,"cached":0,"cacheWrite":0,"output":1}]}}"#
        )
        .is_ok());
    }
    /// #76 补覆盖：别名的目标模型不存在（与"别名键顶掉真实模型"是两条独立
    /// 分支）。指向不存在的模型时事件会算不出成本，必须保存即报错。
    #[test]
    fn alias_must_point_at_a_configured_model() {
        let make = |aliases: &str| {
            format!(r#"{{"version":1,"currency":"USD","aliases":{aliases},"models":{{"real":[{{"input":2,"cached":0,"cacheWrite":0,"output":0}}]}}}}"#)
        };
        let event = |model: &str| Event {
            id: "1".into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: model.into(),
            ts: 1,
            tokens: Tokens { input: 1_000_000, ..Default::default() },
            path: String::new(),
            line: 1,
        };
        assert_eq!(
            Prices::parse(&make(r#"{"nick":"no-such-model"}"#)).unwrap_err(),
            "别名 nick 必须直接指向已配置模型"
        );
        // 空键走的是同一条分支的另一半。
        let empty = Prices::parse(&make(r#"{"":"real"}"#)).unwrap_err();
        assert!(empty.contains("必须直接指向已配置模型"), "{empty}");
        // 非空跑对照：合法别名照旧解析成功，并且真的路由到目标单价 2/百万。
        let ok = Prices::parse(&make(r#"{"nick":"real"}"#)).unwrap();
        assert_eq!(ok.cost(&event("nick")), Some(2.0));
    }
    /// #76 补覆盖：effectiveFrom 写错格式（rate_time 分支）此前无人喂过——
    /// 非 RFC3339 的值会一路走到 `unwrap_or(0)`，等于"这条价从 Unix 纪元生效"，
    /// 用户以为写好了日期、实际顶掉了基础价。
    #[test]
    fn effective_from_must_be_rfc3339_with_an_offset() {
        let make = |from: &str| {
            format!(r#"{{"version":1,"currency":"USD","models":{{"m":[{{"effectiveFrom":"{from}","input":1,"cached":0,"cacheWrite":0,"output":1}}]}}}}"#)
        };
        for bad in ["2026-01-01", "2026-01-01 00:00:00", "not-a-date"] {
            assert_eq!(
                Prices::parse(&make(bad)).unwrap_err(),
                format!("无效生效时间: {bad}；请包含时区")
            );
        }
        // 非空跑对照：UTC 与带偏移的写法都合法。
        assert!(Prices::parse(&make("2026-01-01T00:00:00Z")).is_ok());
        assert!(Prices::parse(&make("2026-01-01T08:00:00+08:00")).is_ok());
    }
    /// #76 补覆盖：version != 1 的分支此前没有测试喂过任何值。
    #[test]
    fn only_version_one_is_accepted() {
        let body = r#""currency":"USD","models":{"m":[{"input":1,"cached":0,"cacheWrite":0,"output":1}]}"#;
        for version in [0u32, 2, 999] {
            let err = Prices::parse(&format!(r#"{{"version":{version},{body}}}"#)).unwrap_err();
            assert!(err.contains("version=1"), "{version} → {err}");
        }
        // 非空跑对照：同一正文、version=1 必须成功，报错才只可能来自版本号。
        assert!(Prices::parse(&format!(r#"{{"version":1,{body}}}"#)).is_ok());
        // 版本号写成字符串是 serde 层的事，也必须拒绝，不能被当成 1。
        assert!(Prices::parse(&format!(r#"{{"version":"1",{body}}}"#))
            .unwrap_err()
            .contains("价格JSON无效"));
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
