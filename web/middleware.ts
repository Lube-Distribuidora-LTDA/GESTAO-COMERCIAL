/* =========================================================
   SENTINELA LUBE — middleware para projetos estáticos na Vercel
   Fica na raiz do projeto (Root Directory), ao lado de
   sentinela-guarda.ts. Sem dependências, sem build.
   ========================================================= */
import { sentinela } from './sentinela-guarda';

// Deixa de fora só imagem, fonte e CSS; JS/JSON passam porque em alguns sistemas são os dados.
// Runtime padrão da Vercel (nodejs). Para edge: acrescente runtime: 'edge'.
export const config = {
  matcher: ['/((?!.*\\.(?:css|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|map)$).*)'],
};

// Sistema que só abre com login do Painel Lube: preencha na instalação (null = aberto).
// Vale quando a lista da central não vem (partida a frio, central fora); com lista, manda o banco.
// Ex.: { projeto: 'gestao-finaceiro', slug: 'gestao-financeiro' }
const FECHADO: { projeto: string; slug: string; rotas?: string[] } | null =
  { projeto: 'gestao-comercial-web', slug: 'gestao-comercial' };

export default async function middleware(request: Request, context?: { waitUntil?(p: Promise<unknown>): void }) {
  let r: Response | null = null;
  try {
    r = await sentinela(request, context, FECHADO ? { fechado: FECHADO } : undefined);
  } catch {
    r = null;   // o núcleo já falha aberto; isto é só cinto de segurança
  }
  // continuar a requisição = x-middleware-next (é o que next() de @vercel/functions faz)
  return r ?? new Response(null, { headers: { 'x-middleware-next': '1' } });
}
