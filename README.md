# Minhas Economias

Sistema de gerenciamento de finanças pessoais usando Google Sheets como banco de dados.

## Como usar

### 1. Pré-requisito: servir os arquivos via HTTP

O app **não funciona** aberto diretamente como `file://` (limitação do OAuth do Google).
Você precisa servi-lo via HTTP. Opções:

**Opção A — Python (mais simples):**
```bash
cd MinhasEconomias
python -m http.server 8080
# Acesse: http://localhost:8080
```

**Opção B — Node.js:**
```bash
npx serve MinhasEconomias
# ou
npx http-server MinhasEconomias -p 8080
```

**Opção C — VS Code Live Server:**
Instale a extensão [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) e clique em "Go Live".

**Opção D — GitHub Pages (recomendado para uso no celular):**
1. Crie um repositório no GitHub
2. Faça upload dos 3 arquivos (`index.html`, `style.css`, `app.js`)
3. Ative o GitHub Pages nas configurações do repositório
4. Use a URL gerada no celular

---

### 2. Criar credenciais no Google Cloud

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/)
2. Crie um novo projeto (ex: "Minhas Economias")
3. Vá em **APIs e Serviços → Biblioteca**
4. Busque e ative **Google Sheets API**
5. Vá em **APIs e Serviços → Credenciais**
6. Clique em **+ Criar Credenciais → ID do cliente OAuth 2.0**
7. Tipo: **Aplicativo da Web**
8. Nome: qualquer (ex: "Minhas Economias Web")
9. Em **Origens JavaScript autorizadas**, adicione:
   - `http://localhost:8080` (para uso local)
   - Sua URL do GitHub Pages, se usar (ex: `https://seu-usuario.github.io`)
10. Clique em **Criar**
11. Copie o **ID do cliente** (formato: `xxxxxxxx.apps.googleusercontent.com`)

---

### 3. Configurar o app

1. Abra o app no navegador
2. Na tela de configuração, cole o **Client ID** copiado acima
3. O ID da planilha já está preenchido — verifique se está correto
4. Confirme os nomes das abas da planilha (`Transações`, `Contas`, `Categorias`)
5. Clique em **Salvar e Continuar**

---

### 4. Fazer login

1. Clique em **Entrar com Google**
2. Autorize o acesso à planilha
3. O app carregará seus dados automaticamente

---

## Estrutura da Planilha

### Aba `Transações`
| Coluna | Nome | Exemplo |
|--------|------|---------|
| A | Data Ocorrência | `01/06/2024` |
| B | Descrição | `Mercado (1 / 3)` |
| C | Valor | `-150.00` (negativo = despesa) |
| D | Categoria | `Supermercado` |
| E | Conta | `Itaú` |

### Aba `Contas`
| Coluna | Nome | Exemplo |
|--------|------|---------|
| A | Conta | `Itaú` |
| B | Total | (calculado pela planilha) |
| C | Status | `Ativo` ou `Inativo` |

### Aba `Categorias`
| Coluna | Nome | Exemplo |
|--------|------|---------|
| A | Categoria | `Supermercado` |
| B | Total | (calculado pela planilha) |
| C | Status | `Ativo` ou `Inativo` |

---

## Funcionalidades

- **Receitas, Despesas e Transferências** — criar, editar e excluir
- **Parcelamento Mensal** — define parcela inicial X de Y; cria todas as transações automaticamente
- **Edição de parcelas** — edite apenas a parcela atual ou esta e todas as futuras
- **Filtro por mês** — navegue entre meses com as setas
- **Filtro por conta** — toque nos chips de conta para filtrar
- **Resumo** — exibe total de receitas, despesas e saldo do período

## Arquivos

```
MinhasEconomias/
├── index.html   — estrutura HTML
├── style.css    — estilos da interface
├── app.js       — lógica da aplicação e integração com Google Sheets
└── README.md    — este arquivo
```
