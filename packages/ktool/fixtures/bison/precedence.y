%define lr.type ielr
%token ID PLUS "+"
%left PLUS
%start expr
%%
expr: ID | expr PLUS expr ;
%%
