%define lr.type ielr
%token ID PLUS "+"
%start expr
%%
expr: ID | expr PLUS expr ;
%%
