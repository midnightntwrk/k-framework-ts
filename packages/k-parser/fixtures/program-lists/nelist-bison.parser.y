%{
#include <stdio.h>
#include <string.h>
#include "node.h"
#include "parser.tab.h"
int yylex(YYSTYPE *, YYLTYPE *, void *);
void yyerror(YYLTYPE *, void *, const char *);
char *enquote(char *);
char *injSymbol(char *, char *);
YYSTYPE mergeAmb(YYSTYPE x0, YYSTYPE x1);
node *result;
extern char *filename;
# define YYMAXDEPTH 10000
# define YYLLOC_DEFAULT(Cur, Rhs, N)                      \
do                                                        \
  if (N)                                                  \
    {                                                     \
      (Cur).filename     = YYRHSLOC(Rhs, 1).filename;     \
      (Cur).first_line   = YYRHSLOC(Rhs, 1).first_line;   \
      (Cur).first_column = YYRHSLOC(Rhs, 1).first_column; \
      (Cur).last_line    = YYRHSLOC(Rhs, N).last_line;    \
      (Cur).last_column  = YYRHSLOC(Rhs, N).last_column;  \
    }                                                     \
  else                                                    \
    {                                                     \
      (Cur).filename     = YYRHSLOC(Rhs, 0).filename;     \
      (Cur).first_line   = (Cur).last_line   =            \
        YYRHSLOC(Rhs, 0).last_line;                       \
      (Cur).first_column = (Cur).last_column =            \
        YYRHSLOC(Rhs, 0).last_column;                     \
    }                                                     \
while (0)
%}

%define api.value.type {union value_type}
%define api.pure
%define lr.type ielr
%lex-param {void *scanner}
%parse-param {void *scanner}
%locations
%initial-action {
  @$.filename = filename;
  @$.first_line = @$.first_column = @$.last_line = @$.last_column = 1;
}
%glr-parser
%define parse.error verbose
%token TOK_1 2 ""
%token TOK_2 3 ","
%token TOK_3 4 "\\/\\/[^\\n\\r]*"
%token TOK_4 5 "\\/\\*([^*]|\\*+[^*/])*\\*+\\/"
%token TOK_5 6 "[\\ \\n\\r\\t]"
%token TOK_6 7 "[a-z]+"
%nterm SortId__
%nterm SortIds__
%start top

%%
top: SortIds__ { result = $1.nterm; } ;
SortId__:
  TOK_6 {
  node *n = malloc(sizeof(node));
  n->symbol = enquote($1.token);
  n->str = true;
  n->location = @$;
  n->hasLocation = 0;
  n->nchildren = 0;
  node *n2 = malloc(sizeof(node) + sizeof(node *));
  n2->symbol = "\\dv{SortId{}}";
  n2->sort = "SortId{}";
  n2->str = false;
  n2->location = @$;
  n2->hasLocation = 0;
  n2->nchildren = 1;
  n2->children[0] = n;
  value_type result = {.nterm = n2};
  $$ = result;
}
%merge <mergeAmb> %dprec 2

;
SortIds__:
  SortId__ {
  node *n = malloc(sizeof(node) + sizeof(node *));
  n->str = false;
  n->location = @$;
  n->hasLocation = 0;
  n->nchildren = 1;
  n->sort = "SortIds{}";
  if (!$1.nterm->str && strncmp($1.nterm->symbol, "inj{", 4) == 0) {
    char *childSort = $1.nterm->children[0]->sort;
    n->symbol = injSymbol(childSort, n->sort);
    n->children[0] = $1.nterm->children[0];
  } else {
    n->symbol = "inj{SortId{}, SortIds{}}";
    n->children[0] = $1.nterm;
  }
  node *n2 = malloc(sizeof(node));
  n2->symbol = "Lbl'Stop'List'LBraQuotUndsCommUndsUnds'PROGRAM-LISTS-NELIST-SYNTAX'Unds'Ids'Unds'Id'Unds'Ids'QuotRBraUnds'Ids{}";
  n2->str = false;
  n2->location = @$;
  n2->hasLocation = 0;
  n2->nchildren = 0;
  n2->sort = "SortIds{}";
  node *n3 = malloc(sizeof(node) + 2*sizeof(node *));
  n3->symbol = "Lbl'UndsCommUndsUnds'PROGRAM-LISTS-NELIST-SYNTAX'Unds'Ids'Unds'Id'Unds'Ids{}";
  n3->str = false;
  n3->location = @$;
  n3->hasLocation = 0;
  n3->nchildren = 2;
  n3->children[0] = n2;
  n3->children[1] = $1.nterm;
  n3->sort = "SortIds{}";
  value_type result = {.nterm = n3};
  $$ = result;
}
%merge <mergeAmb> %dprec 2

  |SortIds__ TOK_2 SortId__ {
  node *n = malloc(sizeof(node) + sizeof(node *)*2);
  n->str = false;
  n->location = @$;
  n->nchildren = 2;
{
    n->symbol = "Lbl'UndsCommUndsUnds'PROGRAM-LISTS-NELIST-SYNTAX'Unds'Ids'Unds'Id'Unds'Ids{}";
    n->sort = "SortIds{}";
    n->hasLocation = 0;
    n->children[0] = $1.nterm;
    n->children[1] = $3.nterm;
    value_type result = {.nterm = n};
    $$ = result;
  }
}
%merge <mergeAmb> %dprec 2

;

%%

void yyerror (YYLTYPE *loc, void *scanner, const char *s) {
    fprintf (stderr, "%s:%d:%d:%d:%d:%s\n", loc->filename, loc->first_line, loc->first_column, loc->last_line, loc->last_column, s);
}
