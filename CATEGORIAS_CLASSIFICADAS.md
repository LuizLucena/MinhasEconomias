# Categorias Classificadas - Guia de Uso

## Como Funciona

A partir de agora, sua aplicação suporta uma nova aba chamada **"Categorias Classificadas"** que permite organizar suas categorias em uma estrutura hierárquica em 3 níveis:

1. **Categoria Raiz** (Criação de Riqueza, Despesas Fixas, etc.)
2. **Subcategoria 1** (Enriquecer, Despesas Pessoais, etc.)
3. **Subcategoria 2** (Academia, Cabeleireiro, etc.) - *opcional*

## Estrutura da Aba "Categorias Classificadas"

Na sua planilha, crie uma aba chamada **"Categorias Classificadas"** com as seguintes colunas:

| Categoria raíz | Subcategoria 1 | Subcategoria 2 |
|---|---|---|
| Criação de Riqueza | Enriquecer | |
| Criação de Riqueza | Sonhos | |
| Despesas Fixas | Despesas Pessoais | |
| Despesas Fixas | Despesas Pessoais | Academia |
| Despesas Fixas | Despesas Pessoais | Cabeleireiro |

**⚠️ Importante:** 
- Deixe a coluna C vazia se uma subcategoria 1 não tiver subcategorias 2
- A primeira linha pode ser um cabeçalho ou começar direto com dados
- As categorias não precisam ter status (funcionamento automático)

## Comportamento na Interface

### 1. Ao Cadastrar uma Transação

Quando você abre o formulário de "Nova Transação", o campo Categoria mostra:
- **Categoria Raiz** em negrito/agrupada
- **Sub1** em itálico ou simples se não tem sub2
- **Sub1 → Sub2** se tem sub2

Exemplo:
```
▼ Criação de Riqueza
    ○ Enriquecer
    ○ Sonhos
▼ Despesas Fixas
    ○ Despesas Pessoais
    ○ Despesas Pessoais → Academia
    ○ Despesas Pessoais → Cabeleireiro
```

### 2. Ao Editar uma Transação

O campo de categoria mostra o **caminho completo** selecionado:
```
"Despesas Fixas->Despesas Pessoais->Academia"
```

### 3. Na Lista de Transações

A categoria é exibida com o **caminho completo** ao lado da conta:
```
Itaú · Despesas Fixas->Despesas Pessoais->Academia
```

## Compatibilidade

Se você NÃO criar a aba "Categorias Classificadas":
- ✅ O app continua funcionando normalmente
- ✅ Usa as categorias simples da aba "Categorias"
- ✅ Sem categorias em árvore, apenas lista simples

Se você criar a aba e preencher:"
- ✅ O app usa AUTOMATICAMENTE a nova hierarquia
- ✅ Antigas transações com categorias simples continuam visíveis
- ✅ Novas transações salvarão o caminho completo

## Dados Salvos no Google Sheets

Quando você cria/edita uma transação, o Google Sheets registra:

| Data | Descrição | Valor | Categoria | Conta |
|------|---|---|---|---|
| 15/05/2024 | Academia | -100,00 | Despesas Fixas->Despesas Pessoais->Academia | Itaú |

O caminho completo com `->` é salvo automaticamente.

## Tips & Tricks

1. **Organize com paciência**: Reserve um tempo para definir sua hierarquia antes de usar
2. **Evite muitos níveis**: 3 níveis (raiz + 2 subs) é o máximo recomendado
3. **Seja consistente**: Use nomes similares para facilitar organização
4. **Sub2 opcional**: Você pode ter categorias com apenas 1 nível de profundidade

## Troubleshooting

### As categorias não aparecem em árvore
- ✓ Verifique se a aba se chama exatamente "Categorias Classificadas"
- ✓ Verifique se os dados estão nas colunas A, B e C
- ✓ Recarregue o app (F5)

### Categorias antigas sumiram
- Isso não acontece! Se não houver "Categorias Classificadas", usa as antigas

### Erro ao salvar categoria
- Verifique se a categoria selecionada é uma subcategoria válida (nível folha)
