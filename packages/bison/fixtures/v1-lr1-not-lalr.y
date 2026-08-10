%token A B C D E
%%
S: A X D | B X E | A Y E | B Y D ;
X: C ;
Y: C ;
