import test from 'node:test';
import assert from 'node:assert/strict';
import { montarEstrutura } from './ia';

test('montarEstrutura', () => {
  const texto = montarEstrutura(
    '8.0.36',
    'erp',
    [
      ['clientes', 'BASE TABLE', ''],
      ['vendas', 'BASE TABLE', 'Vendas do PDV'],
      ['vw_vendas', 'VIEW', 'VIEW'],
    ],
    [
      ['clientes', 'id', 'int', 'NO', 'PRI', 'auto_increment', ''],
      ['clientes', 'cnpj', 'varchar(14)', 'YES', 'UNI', '', 'só dígitos'],
      ['vendas', 'id', 'int', 'NO', 'PRI', 'auto_increment', ''],
      ['vendas', 'cliente_id', 'int', 'NO', 'MUL', '', ''],
      ['vendas', 'total', 'decimal(15,2)', 'YES', '', '', ''],
      ['vw_vendas', 'total', 'decimal(37,2)', 'YES', '', '', ''],
    ],
    [['vendas', 'cliente_id', 'clientes', 'id']],
    [
      ['FUNCTION', 'saldo'],
      ['PROCEDURE', 'fechar_mes'],
    ],
    [
      ['saldo', 'FUNCTION', '0', '', '', 'decimal(15,4)'],
      ['saldo', 'FUNCTION', '1', 'IN', 'p_produto', 'int'],
      ['fechar_mes', 'PROCEDURE', '1', 'IN', 'p_mes', 'date'],
      ['fechar_mes', 'PROCEDURE', '2', 'OUT', 'p_total', 'decimal(15,2)'],
    ],
  );
  assert.deepEqual(texto.split('\n').slice(2), [
    '',
    'TABLE clientes(id int PK auto_increment, cnpj varchar(14) UNIQUE /* só dígitos */)',
    'TABLE vendas(id int PK auto_increment, cliente_id int NOT NULL -> clientes.id, total decimal(15,2)) /* Vendas do PDV */',
    'VIEW vw_vendas(total decimal(37,2))',
    '',
    'FUNCTION saldo(p_produto int) RETURNS decimal(15,4)',
    'PROCEDURE fechar_mes(IN p_mes date, OUT p_total decimal(15,2))',
  ]);
  assert.equal(texto.split('\n')[0], '-- MySQL 8.0.36, banco erp');
});
