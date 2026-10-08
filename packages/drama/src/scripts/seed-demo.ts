/**
 * P11 - Seed 脚本: 生成 demo-romance-3ep 全部 fixtures
 * 运行: npx tsx packages/drama/src/scripts/seed-demo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../../../core/src/paths.js";

const SLUG = "demo-romance-3ep";
const SERIES_DIR = path.join(DATA_ROOT, "series", SLUG);

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(relPath: string, data: unknown) {
  const abs = path.join(SERIES_DIR, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeText(relPath: string, content: string) {
  const abs = path.join(SERIES_DIR, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content, "utf-8");
}

// ─── Series ──────────────────────────────────────────────────────────────────

const series = {
  id: "01JZXH5K3M9QWVBTCE7N8R2SFA",
  slug: SLUG,
  title: "雨天的咖啡馆",
  synopsis: "女主苏念是一名插画师,在一个雨天的咖啡馆偶遇了男主陆辰。两人因一本被雨水打湿的书结缘,经历了办公室的重逢与误解,最终在城市夜景的桥上表白,开启了一段甜蜜的爱情故事。",
  created_at: "2026-05-09T10:00:00Z",
  updated_at: "2026-05-09T10:00:00Z",
  defaults: {
    content_type: "anime_drama",
    platform: "bilibili",
    aspect_ratio: "9:16",
    visual_style: "soft_anime",
    audience: "18-30岁女性",
    tone: "甜蜜温馨",
    pacing: "舒缓",
    camera_style: "cinematic",
    ending_type: "happy_ending",
    llm_provider_id: "ikuncode_gpt55",
    image_provider_id: "local_card_image",
    video_provider_id: "local_mock_video",
    tts_provider_id: "edge_tts",
    tts_voice_id: "zh-CN-XiaoyiNeural",
    max_retake_per_shot: 5,
    max_video_seconds_per_job: 300,
    max_parallel_tasks: 3,
  },
  episodes: ["ep01", "ep02", "ep03"],
  character_ids: ["female-lead", "male-lead"],
  scene_ids: ["cafe-rainy", "office-morning", "bridge-night"],
  target_platform: "bilibili",
};

writeJson("series.json", series);

// ─── Characters ──────────────────────────────────────────────────────────────

const femaleLead = {
  id: "female-lead",
  series_slug: SLUG,
  name: "苏念",
  role: "主角",
  appearance_prompt: "年轻女性,25岁左右,长发微卷,杏仁大眼,穿着米白色针织衫搭配浅蓝色长裙,气质温柔文艺,手持一本旧书",
  personality: "温柔内敛,热爱阅读和绘画,有点小迷糊但内心坚强",
  voice_id: "zh-CN-XiaoyiNeural",
  ref_image_ids: [],
  locked: {},
  status: "drafted",
};

const maleLead = {
  id: "male-lead",
  series_slug: SLUG,
  name: "陆辰",
  role: "主角",
  appearance_prompt: "年轻男性,27岁左右,短发利落,深邃眼神,穿着深灰色西装外套搭配白衬衫,气质沉稳干练,手腕戴一块简约手表",
  personality: "外表高冷实际温柔,工作认真负责,对喜欢的人会默默关心",
  voice_id: "zh-CN-YunxiNeural",
  ref_image_ids: [],
  locked: {},
  status: "drafted",
};

writeJson("characters/female-lead.json", femaleLead);
writeJson("characters/male-lead.json", maleLead);

// ─── Scenes ──────────────────────────────────────────────────────────────────

const cafeRainy = {
  id: "cafe-rainy",
  series_slug: SLUG,
  name: "雨天咖啡馆",
  location: "街角复古咖啡馆室内",
  time_of_day: "下午",
  weather: "小雨",
  atmosphere_prompt: "温暖的咖啡馆内,暖黄色灯光,窗外细雨绵绵,木质桌椅,空气中弥漫着咖啡香气,角落里有一架旧钢琴",
  lighting: "暖黄色室内灯 + 窗外灰蓝天光",
  style_anchor: "日系治愈风,色调温暖柔和",
  ref_image_ids: [],
  locked: {},
  status: "drafted",
};

const officeMorning = {
  id: "office-morning",
  series_slug: SLUG,
  name: "清晨办公室",
  location: "现代写字楼开放式办公区",
  time_of_day: "上午",
  weather: "晴朗",
  atmosphere_prompt: "明亮的开放式办公区,落地窗外是城市天际线,工位整齐排列,有人在喝咖啡,阳光透过百叶窗洒在地板上",
  lighting: "自然日光 + 白色顶灯",
  style_anchor: "现代都市风,色调清新明亮",
  ref_image_ids: [],
  locked: {},
  status: "drafted",
};

const bridgeNight = {
  id: "bridge-night",
  series_slug: SLUG,
  name: "夜景大桥",
  location: "城市江边步行桥",
  time_of_day: "夜晚",
  weather: "晴朗",
  atmosphere_prompt: "城市夜景大桥,桥上灯光倒映在江面,远处是璀璨的城市天际线,微风吹过,气氛浪漫",
  lighting: "桥上暖色路灯 + 远处城市霓虹",
  style_anchor: "浪漫夜景风,色调偏暖紫与金色",
  ref_image_ids: [],
  locked: {},
  status: "drafted",
};

writeJson("scenes/cafe-rainy.json", cafeRainy);
writeJson("scenes/office-morning.json", officeMorning);
writeJson("scenes/bridge-night.json", bridgeNight);

// ─── Episodes & Shots ────────────────────────────────────────────────────────

interface ShotDef {
  id: string;
  index: number;
  duration_sec: number;
  character_ids: string[];
  scene_id: string;
  shot_type: string;
  camera_movement: string;
  action: string;
  dialogue: string;
  voiceover: string;
  prompt_img: string;
  prompt_vid: string;
}

interface EpisodeDef {
  id: string;
  index: number;
  title: string;
  synopsis: string;
  script: string;
  hook_type: string;
  status: "drafted" | "storyboarded";
  shots: ShotDef[];
}

const episodes: EpisodeDef[] = [
  {
    id: "ep01",
    index: 1,
    title: "雨天的邂逅",
    synopsis: "苏念在雨天躲进一家咖啡馆,意外与陆辰共用一张桌子,两人因一本被打湿的书开始交谈。",
    hook_type: "悬念",
    status: "storyboarded",
    script: `外面下着小雨,苏念抱着书包跑进街角的咖啡馆。她抖落身上的雨珠,环顾四周——只剩角落一张桌子有空位。

对面坐着一个穿灰色外套的男人,正低头看手机。苏念小心翼翼地坐下,从包里拿出一本旧书。

雨越下越大,一滴水从伞尖滑落,正好打在书页上。苏念惊呼一声,手忙脚乱地擦拭。

"用这个吧。"对面的男人递过来一包纸巾。苏念抬头,对上一双深邃的眼睛。

"谢谢……"她接过纸巾,有些不好意思地笑了笑。

"《小王子》？"男人瞥了一眼书封面,"我也很喜欢这本书。"

两人就这样聊了起来。窗外的雨声成了最好的背景音乐。不知不觉,咖啡馆要打烊了。

"我叫陆辰。"他站起来,递给她一张名片。苏念接过名片,看着他的背影消失在雨幕中,心跳微微加速。`,
    shots: [
      {
        id: "s0001", index: 1, duration_sec: 5, character_ids: ["female-lead"], scene_id: "cafe-rainy",
        shot_type: "medium", camera_movement: "static",
        action: "苏念推开咖啡馆的玻璃门,抖落身上的雨珠,环顾四周寻找座位",
        dialogue: "", voiceover: "外面下着小雨,苏念抱着书包跑进街角的咖啡馆。",
        prompt_img: "年轻女性推开咖啡馆玻璃门,身上有雨珠,暖黄色室内灯光,窗外细雨,日系治愈风",
        prompt_vid: "女性推开玻璃门走进咖啡馆,微微抖动肩膀甩落雨珠,环顾四周",
      },
      {
        id: "s0002", index: 2, duration_sec: 4, character_ids: ["female-lead", "male-lead"], scene_id: "cafe-rainy",
        shot_type: "long", camera_movement: "push_in",
        action: "苏念走向角落的空位,陆辰坐在对面低头看手机",
        dialogue: "", voiceover: "只剩角落一张桌子有空位。对面坐着一个穿灰色外套的男人。",
        prompt_img: "咖啡馆角落座位,女性走向座位,对面男性低头看手机,暖黄灯光,木质桌椅",
        prompt_vid: "镜头从远处推近到角落座位,女性走来坐下",
      },
      {
        id: "s0003", index: 3, duration_sec: 5, character_ids: ["female-lead"], scene_id: "cafe-rainy",
        shot_type: "close_up", camera_movement: "static",
        action: "一滴水打在书页上,苏念惊呼手忙脚乱擦拭",
        dialogue: "啊……", voiceover: "雨越下越大,一滴水从伞尖滑落,正好打在书页上。",
        prompt_img: "特写:水滴打在旧书书页上,旁边是女性纤细的手指,暖黄灯光",
        prompt_vid: "水滴落在书页上晕开,女性手指慌忙擦拭书页",
      },
      {
        id: "s0004", index: 4, duration_sec: 6, character_ids: ["female-lead", "male-lead"], scene_id: "cafe-rainy",
        shot_type: "medium", camera_movement: "static",
        action: "陆辰递过纸巾,苏念抬头对上他的眼神,微笑接过",
        dialogue: "用这个吧。", voiceover: "",
        prompt_img: "男性递出纸巾包,女性抬头微笑对视,咖啡馆暖光,日系治愈色调",
        prompt_vid: "男性手臂伸出递纸巾,女性抬头露出微笑",
      },
      {
        id: "s0005", index: 5, duration_sec: 8, character_ids: ["female-lead", "male-lead"], scene_id: "cafe-rainy",
        shot_type: "medium", camera_movement: "dolly",
        action: "两人隔着桌子聊天,气氛轻松愉快",
        dialogue: "《小王子》？我也很喜欢这本书。", voiceover: "",
        prompt_img: "两人隔着咖啡桌愉快交谈,桌上放着咖啡杯和旧书,暖黄灯光,窗外雨幕",
        prompt_vid: "两人隔着桌子交谈,偶尔微笑,镜头缓慢环绕",
      },
      {
        id: "s0006", index: 6, duration_sec: 5, character_ids: ["female-lead", "male-lead"], scene_id: "cafe-rainy",
        shot_type: "close_up", camera_movement: "push_in",
        action: "陆辰起身递名片,苏念接过看着他离去的背影",
        dialogue: "我叫陆辰。", voiceover: "苏念接过名片,看着他的背影消失在雨幕中,心跳微微加速。",
        prompt_img: "特写:男性递出名片,女性手指接过,背景虚化暖黄灯光",
        prompt_vid: "男性递名片,女性接过低头看,镜头推近到名片特写",
      },
    ],
  },
  {
    id: "ep02",
    index: 2,
    title: "办公室重逢",
    synopsis: "苏念去一家公司洽谈插画合作项目,没想到对接人正是陆辰。两人在会议室里认出彼此,陆辰主动提出一起午餐。",
    hook_type: "伏笔",
    status: "drafted",
    script: `苏念抱着作品集走进写字楼,今天是她第一次来这家公司谈插画合作。

推开会议室的门,她愣住了——坐在对面的项目负责人,竟然是那天咖啡馆里的男人。

"苏小姐？"陆辰也认出了她,嘴角微微上扬,"世界真小。"

苏念定了定神,打开作品集开始展示。陆辰听得很认真,不时点头。

会议结束后,同事们陆续离开。陆辰叫住了她。

"中午有空吗？楼下新开了一家日料,我想……继续那天没聊完的话题。"

苏念心跳加速,但表面上保持着职业微笑："好啊,正好我也饿了。"

两人并肩走出会议室,阳光从落地窗洒进来,照在他们身上。苏念偷偷看了他一眼,发现他也在看自己。

原来命运的安排,有时候就是这么巧妙。`,
    shots: [
      {
        id: "s0001", index: 1, duration_sec: 4, character_ids: ["female-lead"], scene_id: "office-morning",
        shot_type: "long", camera_movement: "dolly",
        action: "苏念走进写字楼大堂,抱着作品集四处张望",
        dialogue: "", voiceover: "苏念抱着作品集走进写字楼,今天是她第一次来这家公司谈插画合作。",
        prompt_img: "女性抱着作品集走进现代写字楼大堂,阳光从落地窗洒入,色调清新明亮",
        prompt_vid: "女性走进写字楼大堂,环顾四周,走向电梯方向",
      },
      {
        id: "s0002", index: 2, duration_sec: 5, character_ids: ["female-lead", "male-lead"], scene_id: "office-morning",
        shot_type: "medium", camera_movement: "static",
        action: "苏念推开会议室门,看到陆辰坐在对面,两人同时愣住",
        dialogue: "苏小姐？世界真小。", voiceover: "",
        prompt_img: "会议室门口,女性推门惊讶表情,对面男性微笑,落地窗外城市天际线",
        prompt_vid: "女性推开门,表情从平静变为惊讶,对面男性微笑",
      },
      {
        id: "s0003", index: 3, duration_sec: 6, character_ids: ["female-lead"], scene_id: "office-morning",
        shot_type: "medium", camera_movement: "static",
        action: "苏念打开作品集向会议桌对面展示插画作品",
        dialogue: "", voiceover: "苏念定了定神,打开作品集开始展示。",
        prompt_img: "女性在会议室展示作品集,桌上散落插画稿,白色顶灯,现代办公环境",
        prompt_vid: "女性翻开作品集,手指指向画面,自信地讲解",
      },
      {
        id: "s0004", index: 4, duration_sec: 4, character_ids: ["male-lead"], scene_id: "office-morning",
        shot_type: "close_up", camera_movement: "static",
        action: "陆辰认真听讲,微微点头,目光专注",
        dialogue: "", voiceover: "陆辰听得很认真,不时点头。",
        prompt_img: "特写:男性认真倾听的表情,微微点头,会议室背景虚化",
        prompt_vid: "男性专注倾听,微微点头",
      },
      {
        id: "s0005", index: 5, duration_sec: 8, character_ids: ["female-lead", "male-lead"], scene_id: "office-morning",
        shot_type: "medium", camera_movement: "push_in",
        action: "会议结束同事离开,陆辰叫住苏念邀请午餐",
        dialogue: "中午有空吗？楼下新开了一家日料,我想……继续那天没聊完的话题。", voiceover: "",
        prompt_img: "会议室里两人对视,其他座位已空,阳光透过百叶窗,温暖色调",
        prompt_vid: "男性起身叫住准备离开的女性,两人对视",
      },
      {
        id: "s0006", index: 6, duration_sec: 5, character_ids: ["female-lead", "male-lead"], scene_id: "office-morning",
        shot_type: "long", camera_movement: "dolly",
        action: "两人并肩走出会议室,阳光洒在身上,互相偷看",
        dialogue: "好啊,正好我也饿了。", voiceover: "两人并肩走出会议室,阳光从落地窗洒进来。苏念偷偷看了他一眼,发现他也在看自己。",
        prompt_img: "两人并肩走在走廊,阳光从落地窗洒入,温暖色调,现代办公环境",
        prompt_vid: "两人并肩走出会议室,走在阳光走廊中,偶尔互看",
      },
    ],
  },
  {
    id: "ep03",
    index: 3,
    title: "桥上告白",
    synopsis: "经过多次接触后,陆辰约苏念傍晚在江边大桥散步。在城市夜景的映衬下,陆辰鼓起勇气向苏念表白,两人在桥上相拥。",
    hook_type: "甜蜜结局",
    status: "drafted",
    script: `傍晚时分,陆辰发来消息："今晚有空吗？江边的桥上风景很好。"

苏念换上一条新裙子,对着镜子看了又看,心跳得厉害。

桥上,陆辰已经在等她了。远处的城市天际线渐渐亮起灯火。

"你来了。"他笑着递过一杯热奶茶。

两人沿着桥慢慢走着,聊着最近的工作和生活。江风吹过,苏念的头发被吹乱,陆辰伸手帮她别到耳后。

两人的手指不小心碰到了一起。苏念没有躲开。

"苏念,"陆辰停下脚步,转身面对她,"从那天在咖啡馆见到你,我就一直在想……"

"想什么？"苏念抬头,对上他认真的眼神。

"想每天都见到你。"陆辰轻轻握住她的手,"我喜欢你。"

桥上的灯光映在苏念泛红的脸颊上。她低下头,嘴角藏不住笑意。

"我也……喜欢你。"

陆辰轻轻拥她入怀。远处的城市灯火璀璨,仿佛在为他们庆祝。`,
    shots: [
      {
        id: "s0001", index: 1, duration_sec: 4, character_ids: ["female-lead"], scene_id: "bridge-night",
        shot_type: "medium", camera_movement: "static",
        action: "苏念对着镜子整理裙子,深呼吸后出门",
        dialogue: "", voiceover: "苏念换上一条新裙子,对着镜子看了又看,心跳得厉害。",
        prompt_img: "女性对着穿衣镜整理裙摆,卧室暖色灯光,表情期待又紧张",
        prompt_vid: "女性对着镜子转身整理裙子,深呼吸",
      },
      {
        id: "s0002", index: 2, duration_sec: 5, character_ids: ["female-lead", "male-lead"], scene_id: "bridge-night",
        shot_type: "long", camera_movement: "push_in",
        action: "苏念走上大桥,陆辰在桥上等她,递过一杯奶茶",
        dialogue: "你来了。", voiceover: "桥上,陆辰已经在等她了。远处的城市天际线渐渐亮起灯火。",
        prompt_img: "夜景大桥上,男性等待女性走来,递出奶茶,远处城市灯火璀璨",
        prompt_vid: "女性走上桥,男性微笑迎上递出奶茶,镜头推近",
      },
      {
        id: "s0003", index: 3, duration_sec: 6, character_ids: ["female-lead", "male-lead"], scene_id: "bridge-night",
        shot_type: "medium", camera_movement: "dolly",
        action: "两人沿着桥并肩散步,聊着天,江风吹过",
        dialogue: "", voiceover: "两人沿着桥慢慢走着,聊着最近的工作和生活。",
        prompt_img: "两人并肩在夜景大桥上散步,江风微拂,远处城市灯火,浪漫氛围",
        prompt_vid: "两人并肩在桥上散步,女性头发被风吹起",
      },
      {
        id: "s0004", index: 4, duration_sec: 5, character_ids: ["female-lead", "male-lead"], scene_id: "bridge-night",
        shot_type: "close_up", camera_movement: "static",
        action: "陆辰帮苏念别好被风吹乱的头发,两人的手指碰到一起",
        dialogue: "", voiceover: "苏念的头发被吹乱,陆辰伸手帮她别到耳后。两人的手指不小心碰到了一起。",
        prompt_img: "特写:男性手指帮女性别好耳边碎发,桥上暖色灯光,浪漫氛围",
        prompt_vid: "男性伸手帮女性别头发,手指轻触",
      },
      {
        id: "s0005", index: 5, duration_sec: 10, character_ids: ["female-lead", "male-lead"], scene_id: "bridge-night",
        shot_type: "medium", camera_movement: "static",
        action: "陆辰停下脚步转身面对苏念,认真告白",
        dialogue: "苏念,从那天在咖啡馆见到你,我就一直在想……想每天都见到你。我喜欢你。", voiceover: "",
        prompt_img: "夜景桥上两人面对面,男性认真告白表情,女性抬头对视,远处灯火璀璨",
        prompt_vid: "男性停下转身面对女性,认真说话,女性抬头",
      },
      {
        id: "s0006", index: 6, duration_sec: 8, character_ids: ["female-lead", "male-lead"], scene_id: "bridge-night",
        shot_type: "long", camera_movement: "dolly",
        action: "苏念低头微笑,回应告白,两人在桥上相拥",
        dialogue: "我也……喜欢你。", voiceover: "陆辰轻轻拥她入怀。远处的城市灯火璀璨,仿佛在为他们庆祝。",
        prompt_img: "夜景大桥上两人相拥,远处城市天际线灯火辉煌,浪漫氛围,暖紫金色调",
        prompt_vid: "女性低头微笑回应,两人相拥,镜头缓缓拉远展现城市夜景",
      },
    ],
  },
];

// 生成每集的 episode.json, storyboard.json, shots, script.md
for (const ep of episodes) {
  const epDir = `episodes/${ep.id}`;

  // episode.json
  writeJson(`${epDir}/episode.json`, {
    id: ep.id,
    series_slug: SLUG,
    index: ep.index,
    title: ep.title,
    synopsis: ep.synopsis,
    script_path: `${epDir}/script.md`,
    target_duration_sec: ep.shots.reduce((sum, s) => sum + s.duration_sec, 0),
    target_shot_count: ep.shots.length,
    hook_type: ep.hook_type,
    status: ep.status,
    storyboard_path: `${epDir}/storyboard.json`,
  });

  // script.md
  writeText(`${epDir}/script.md`, `# ${ep.title}\n\n${ep.script}\n`);

  // storyboard.json
  writeJson(`${epDir}/storyboard.json`, {
    episode_id: ep.id,
    series_slug: SLUG,
    shots: ep.shots.map((s) => ({ shot_id: s.id, index: s.index })),
    updated_at: "2026-05-09T10:00:00Z",
  });

  // shots
  for (const shot of ep.shots) {
    writeJson(`${epDir}/shots/${shot.id}.json`, {
      id: shot.id,
      series_slug: SLUG,
      episode_id: ep.id,
      index: shot.index,
      duration_sec: shot.duration_sec,
      character_ids: shot.character_ids,
      scene_id: shot.scene_id,
      shot_type: shot.shot_type,
      camera_movement: shot.camera_movement,
      action: shot.action,
      dialogue: shot.dialogue,
      voiceover: shot.voiceover,
      prompt_img: shot.prompt_img,
      prompt_vid: shot.prompt_vid,
      generations: [],
      status: "drafted",
      failures: [],
    });
  }
}

// ─── Assets 目录占位 ─────────────────────────────────────────────────────────

ensureDir(path.join(SERIES_DIR, "assets", "images"));
ensureDir(path.join(SERIES_DIR, "assets", "videos"));
ensureDir(path.join(SERIES_DIR, "assets", "audio"));
writeText("assets/index.jsonl", "");

console.log(`Fixtures generated at: ${SERIES_DIR}`);
console.log("Files:");
function listFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFiles(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
const allFiles = listFiles(SERIES_DIR);
for (const f of allFiles) console.log(`  ${f}`);
console.log(`Total: ${allFiles.length} files`);
