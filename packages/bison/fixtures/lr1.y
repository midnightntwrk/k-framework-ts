%define lr.type ielr
%token ID
%start start
%%
start: ID { /* SEMANTIC_ACTION_MUST_NOT_APPEAR_IN_XML */ } ;
%%
