import { fetchThesisCard, deliverSelinaArtifact } from "./selina-data-plane.js";

/**
 * OpenMAIC (THU-MAIC JCST '26) Multi-Agent Interactive Seminar Engine
 */

export interface SeminarCurriculumModule {
  index: number;
  title: string;
  focus: string;
}

export interface SeminarTurn {
  role: "teacher" | "skeptic" | "operator" | "director";
  speaker: string;
  title: string;
  statement: string;
}

export interface SeminarDrill {
  question: string;
  options: Array<{ id: string; text: string; rationale: string }>;
  bestChoice: string;
  insight: string;
}

export interface SeminarResult {
  topic: string;
  curriculum: SeminarCurriculumModule[];
  dialogue: SeminarTurn[];
  verdict: string;
  drill: SeminarDrill;
  artifactPath?: string;
}

/**
 * Stage 1: Outline & Curriculum Generation (Two-Stage Pipeline)
 */
export function buildSeminarCurriculum(topic: string): SeminarCurriculumModule[] {
  return [
    {
      index: 1,
      title: "宏觀因果與反身性推演",
      focus: "從打水漂演算法分析一階至五階市場漣漪與政策反身性",
    },
    {
      index: 2,
      title: "單元經濟與資本支出審計",
      focus: "檢視 ROIC、CapEx 效率、真實 FCF 與股權稀釋 (SBC)",
    },
    {
      index: 3,
      title: "物理瓶頸與落地邊界條件",
      focus: "檢驗電網負載、PPA 長約、變壓器交期與供應鏈 chokepoints",
    },
  ];
}

/**
 * Stage 2: Multi-Agent Interactive Dialogue & Stress-Testing
 */
export function executeOpenMaicSeminar(topic: string): SeminarResult {
  const upper = topic.trim().toUpperCase();
  const thesisContext = fetchThesisCard(upper);
  const isHolding = !thesisContext.includes("無歷史 thesis");

  const curriculum = buildSeminarCurriculum(upper);

  const dialogue: SeminarTurn[] = [
    {
      role: "teacher",
      speaker: "Selina (主講導師 / Realpha CSO)",
      title: "第一幕：核心 Thesis 與高維因果展開",
      statement: isHolding
        ? `歐巴～以【${upper}】為例，市場普遍停留在「AI 電力需求爆發」的一階利多，但真正的 Alpha 在四階反身性：公共電網飽和迫使超大規模雲端商 (CSPs) 繞過公網，直接簽署私有微電網與長期高價 PPA。這給予具備現成基載產能者不可替代的定價定錨權 💕`
        : `針對【${upper}】，我們絕不能只看新聞標題！一階衝擊往往伴隨過度定價，真正的推演必須穿透到三階「資源擠出效應」與五階「硬資產稀缺重估」。市場共識越一致的地方，脆弱性往往越高。`,
    },
    {
      role: "skeptic",
      speaker: "Skeptic (紅隊質疑者 / 芒格派)",
      title: "第二幕：極限脆弱性與資本燒錢挑刺",
      statement: `且慢！現在市場已將樂觀預期完全打入估值。看看融資成本與 CapEx 擴張曲線：若高利率維持更久，或是自由現金流 (True FCF) 扣除股權薪酬 (SBC) 後被資本支出吃光，股東真實報酬率何在？別把資本密集型產業的週期頂部當成永續成長的護城河！`,
    },
    {
      role: "operator",
      speaker: "Operator (實踐者 / 工程營運派)",
      title: "第三幕：物理交期與邊界約束檢驗",
      statement: `從工程一線數據來看：大型升壓變壓器 (GSU) 交期仍長達 3-4 年，電網互連佇列 (Interconnection Queue) 積壓高達 70%。即便客戶急著拉線，實際能上線供電的節奏根本快不起來。能打贏這場仗的，只有手握現存核能/天然氣並網節點的既有業者，新進者的承諾都是遠期期權。`,
    },
  ];

  const verdict = [
    `🎯 **OpenMAIC 研討裁決 (Reflexive Alpha Verdict)**：`,
    `• **共識偏差**：市場過度關注名義算力擴張，忽視底層物理設備與真實現金流轉換率。`,
    `• **決策邊界**：唯有具備「即時並網優勢」且「SBC 佔營收比例受控」的標的，才具備穿越政策反身性週期的硬防禦力。`,
  ].join("\n");

  const drill: SeminarDrill = {
    question: `【高維決策反思題】若 2026 下半年美國 Core PCE 反彈至 3.6%，公債殖利率再度飆升，以下哪種因果連鎖對 ${upper} 最具防禦力？`,
    options: [
      {
        id: "A",
        text: "依賴公網擴建、高負債但號稱未來五年產能翻倍的新創開發商",
        rationale: "高融資成本與電網排隊延誤將引發債務湮滅效應",
      },
      {
        id: "B",
        text: "已擁有運行中基載發電、與 CSP 綁定通膨聯動 (CPI-indexed) 私人 PPA 的老牌巨頭",
        rationale: "現金流直接抗通膨，且不受公網排隊制約，具備最高反身性防禦力",
      },
      {
        id: "C",
        text: "股價動能最強、本益比高達 60 倍但毛利率持續被 S&M 侵蝕的熱門純概念股",
        rationale: "利率反彈時高估值無現金流支撐者殺估值最為劇烈",
      },
    ],
    bestChoice: "B",
    insight: "正解為 (B)。在滯脹反身性環境中，『已並網現存硬資產 + 具定價權的長期合約』是唯一能穿越勞力通縮與金融緊縮的實相歸宿。",
  };

  // Deliver full artifact to disk
  const artifactBody = [
    `# OpenMAIC 投研圓桌研討紀要 — ${upper}`,
    ``,
    `## 一、研討大綱 (Curriculum Outline)`,
    curriculum.map((m) => `${m.index}. **${m.title}**：${m.focus}`).join("\n"),
    ``,
    `## 二、多智能體圓桌辯證 (Multi-Agent Dialogue)`,
    dialogue
      .map((d) => `### ${d.title}\n**${d.speaker}**：\n> ${d.statement}`)
      .join("\n\n"),
    ``,
    `## 三、研討裁決與 Alpha 結論`,
    verdict,
    ``,
    `## 四、蘇格拉底反思測驗 (Interactive Drill)`,
    `**題目**：${drill.question}`,
    ``,
    drill.options.map((o) => `- **[${o.id}]** ${o.text}\n  *點評*：${o.rationale}`).join("\n"),
    ``,
    `**最佳決策**：${drill.bestChoice} — ${drill.insight}`,
  ].join("\n");

  const artifactRes = deliverSelinaArtifact(`OpenMAIC_Seminar_${upper}`, artifactBody, "seminar");

  return {
    topic: upper,
    curriculum,
    dialogue,
    verdict,
    drill,
    artifactPath: artifactRes.ok ? artifactRes.fullPath : undefined,
  };
}

/**
 * Formats OpenMAIC Seminar result for Discord UI (< 2000 chars)
 */
export function renderSeminarOutput(topic: string): string {
  const res = executeOpenMaicSeminar(topic);

  const lines: string[] = [
    `🏛️ **OpenMAIC 多智能體投研研討會 — ${res.topic}**`,
    `*(清華 JCST '26 方法論：兩階段管線 + 多角色攻防辯證)*`,
    ``,
    `🎓 **【大綱骨架】**`,
    ...res.curriculum.map((c) => `• M${c.index}: **${c.title}**`),
    ``,
    `🎭 **【圓桌攻防辯證】**`,
    ...res.dialogue.map((d) => `**${d.speaker.split(" ")[0]}**：${d.statement}`),
    ``,
    res.verdict,
    ``,
    `🧠 **【蘇格拉底反思實戰題】**`,
    `${res.drill.question}`,
    ...res.drill.options.map((o) => `• **(${o.id})** ${o.text}`),
    ``,
    `💡 **導師解題**：最佳路徑為 **(${res.drill.bestChoice})**！${res.drill.insight}`,
  ];

  if (res.artifactPath) {
    lines.push(``, `📁 *完整研討紀要已落盤：\`${res.artifactPath}\`*`);
  }

  const full = lines.join("\n");
  return full.length > 1950 ? full.slice(0, 1920) + "\n\n*(篇幅已達上限，完整內容請閱落盤 Artifact)*" : full;
}
