import { watch } from 'vue';

import { charTagLib } from '@/state/charTags';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import {
  bumpPublicRevision,
  clonePublic,
  generate,
  getBackendStatus,
  getCharacters,
  getPublicRevision,
} from './api';
import {
  PUBLIC_API_VERSION,
  type GenerateOptions,
  type GenerateRequest,
  type GetCharactersOptions,
  type PublicCapabilities,
  type PublicChangeListener,
  type PublicChangeNotice,
  type STBaiBaiImageApi,
} from './types';

/**
 * 公开接口的注册与事件面(与柏宝书 src/public/register.ts 同款,第三方学一套就够)。
 *
 * 第三方怎么拿到接口——**两条路都得给**,因为插件加载顺序不确定:
 * - 它比柏宝绘晚加载:直接读 globalThis.STBaiBaiImage 就有;
 * - 它比柏宝绘早加载:读到 undefined,只能等 window 的 'st-baibai-image:ready'。
 * 只给其中一条,另一半场合的第三方就得写轮询——那是我们的锅,不是它的。
 */

/** 与原版柏宝绘共存：主名被原版占用时，本 fork 退到带后缀的名字，不互相覆盖。 */
const PUBLIC_API_KEY_PRIMARY = 'STBaiBaiImage';
const PUBLIC_API_KEY_FALLBACK = 'STBaiBaiImageNsfw';
const PUBLIC_READY_EVENT_PRIMARY = 'st-baibai-image:ready';
const PUBLIC_CHANGED_EVENT_PRIMARY = 'st-baibai-image:changed';
let ownsPrimaryName = false;

export const PUBLIC_READY_EVENT = 'st-baibai-image-nsfw:ready';
export const PUBLIC_CHANGED_EVENT = 'st-baibai-image-nsfw:changed';

const capabilities: PublicCapabilities = {
  globalApi: true,
  characterLibrary: true,
  generate: true,
  saveToGallery: true,
  events: true,
};

const listeners = new Set<PublicChangeListener>();
let registered = false;
let ready = false;
let changeQueued = false;

function chatId(): string | null {
  return getContext()?.getCurrentChatId?.() ?? null;
}

function notice(type: PublicChangeNotice['type']): PublicChangeNotice {
  return {
    type,
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chatId: chatId(),
    capabilities: clonePublic(capabilities),
  };
}

/**
 * 发通知。**每个接收方各拿一份深拷贝**:同一个 detail 对象传给 N 个订阅者时,
 * 头一个改了它、后面的就收到被篡改的内容(而且两边都不知道发生了什么)。
 * 订阅回调抛错只记 console:一个第三方写崩了不能连累其余订阅者收不到通知。
 */
function emitNotice(type: PublicChangeNotice['type']): void {
  const detail = notice(type);
  for (const listener of listeners) {
    try {
      listener(clonePublic(detail));
    } catch (error) {
      console.warn('[柏宝绘·性爱聚焦] 公共接口订阅回调异常', error);
    }
  }
  const eventName = type === 'ready' ? PUBLIC_READY_EVENT : PUBLIC_CHANGED_EVENT;
  window.dispatchEvent(new CustomEvent(eventName, { detail: clonePublic(detail) }));
  // 只有在主名没被原版占走时才顺带发主事件，避免第三方收到双份通知
  if (ownsPrimaryName) {
    const primaryName = type === 'ready' ? PUBLIC_READY_EVENT_PRIMARY : PUBLIC_CHANGED_EVENT_PRIMARY;
    window.dispatchEvent(new CustomEvent(primaryName, { detail: clonePublic(detail) }));
  }
}

/**
 * 攒一个微任务再发。recomputeCharTags() 一次会整体替换 entries,
 * 而切聊天/删楼/滑动会连着触发好几次重算 —— 不攒的话第三方一秒内收到十几条同样的通知,
 * 每条都可能引它去做一次全量刷新。
 */
function queueChangedNotice(): void {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    bumpPublicRevision();
    if (ready) emitNotice('changed');
  });
}

function createApi(): STBaiBaiImageApi {
  // 冻结:第三方(或它引的某个库)往接口对象上挂东西、或替换掉 generate,
  // 会让后到的另一个第三方拿到被改过的接口。冻结让这类改动直接失败而不是静默生效。
  return Object.freeze({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    get capabilities() {
      return clonePublic(capabilities);
    },
    getCharacters: (options?: GetCharactersOptions) => getCharacters(options),
    getBackendStatus: () => getBackendStatus(),
    generate: (request: GenerateRequest, options?: GenerateOptions) => generate(request, options),
    subscribe(listener: PublicChangeListener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe listener 必须是函数');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/**
 * 注册公开接口。**必须在 hydrateSettings() 之后调**:
 * 设置回灌前 settings 还是内存里的默认值,getBackendStatus() 会把「其实配好了的用户」
 * 报成 not_configured,第三方据此直接不给出图入口。
 */
export function registerPublicInterface(): void {
  if (registered) return;
  registered = true;

  bumpPublicRevision();
  const api = createApi();
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  // 主名空着（没装原版）才占主名，让柏宝书这类第三方照旧能找到接口；
  // 原版也在跑时让出主名，本 fork 只挂带后缀的那个。
  ownsPrimaryName = !scope[PUBLIC_API_KEY_PRIMARY];
  scope[PUBLIC_API_KEY_FALLBACK] = api;
  if (ownsPrimaryName) scope[PUBLIC_API_KEY_PRIMARY] = api;

  // 角色库是响应式派生结果,一律 watch 它本身,不去逐个订阅那些**导致**它变的事件
  // (CHAT_CHANGED / 删楼 / 滑动 / 用户手动编辑 / 柏宝书同步……漏一个就少一次通知)。
  watch(() => charTagLib.entries, queueChangedNotice, { deep: true });

  ready = true;
  emitNotice('ready');
  console.log('[柏宝绘·性爱聚焦] 公共接口已就绪', clonePublic(capabilities));
}
