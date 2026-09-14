// Fila local (IndexedDB) — grava processos/pontos antes de tentar o Supabase.
// Vanilla, sem dependência externa (o app inteiro é estático, sem build step).

const DB_NAME = 'monitoramento-prf';
const DB_VERSION = 4;
const STORES = ['processos', 'pontos', 'kml_pontos', 'kml_poligonos'];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          const os = db.createObjectStore(store, { keyPath: 'id' });
          os.createIndex('sincronizado', 'sincronizado');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export async function salvarLocal(storeName, registro) {
  const comFlag = { ...registro, sincronizado: false };
  await tx(storeName, 'readwrite', (store) => store.put(comFlag));
  return comFlag;
}

export async function removerLocal(storeName, id) {
  await tx(storeName, 'readwrite', (store) => store.delete(id));
}

export async function limparStore(storeName) {
  await tx(storeName, 'readwrite', (store) => store.clear());
}

export async function marcarSincronizado(storeName, id) {
  await tx(storeName, 'readwrite', (store) => {
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, sincronizado: true });
    };
  });
}

export async function listarTodos(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listarPendentes(storeName) {
  const todos = await listarTodos(storeName);
  return todos.filter((r) => r.sincronizado === false);
}

// pontos NÃO entram aqui de propósito: não sincronizam mais sozinhos (ver sincronizarPendentes em
// app.js) — ficam retidos pra revisão manual na aba Relatório, então "pendente" pra eles significa
// "aguardando revisão", não "sem sinal". Esse contador é só pra processos/KML, que continuam
// automáticos como antes.
export async function contarPendentes() {
  const [processos, kmlPontos, kmlPoligonos] = await Promise.all([
    listarPendentes('processos'),
    listarPendentes('kml_pontos'),
    listarPendentes('kml_poligonos')
  ]);
  return processos.length + kmlPontos.length + kmlPoligonos.length;
}

// Dados do técnico avaliador ficam no navegador do avaliador (não mudam por processo).
const TECNICO_KEY = 'monitoramento-prf:tecnico';

export function salvarTecnico(dados) {
  localStorage.setItem(TECNICO_KEY, JSON.stringify(dados));
}

export function carregarTecnico() {
  try {
    return JSON.parse(localStorage.getItem(TECNICO_KEY)) || {};
  } catch {
    return {};
  }
}

export function limparTecnico() {
  localStorage.removeItem(TECNICO_KEY);
}
