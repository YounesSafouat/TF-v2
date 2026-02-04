# Recap des proprietes internes - Tous les onglets

## Onglets (tabs.json)

| id | title | Statut |
|---|---|---|
| `decret` | Decret | EXISTANT |
| `naturalisation_mariage` | Naturalisation Mariage | EXISTANT |
| `autre` | Autre | EXISTANT |
| `fraterie` | Naturalisation par fratrie | EXISTANT |
| `ascendant` | Ascendant | NOUVEAU |
| `aes` | AES | NOUVEAU |
| `titre_sejour_plein_droit` | Titre de sejour de Plein droit | NOUVEAU |
| `renouvellement` | Renouvellement | NOUVEAU |

---

## Proprietes conditionnelles (conditionalProperties.json)

| Nom interne | Question Excel | Statut |
|---|---|---|
| `sous_categorie` | Type de procedure / sous-categorie | EXISTANT |
| `avez_vous_un_statut_refugie_ou_apatride__` | Avez-vous un statut Refugie ou Apatride ? | EXISTANT |
| `quelle_est_votre_situation_professionnel__` | Quelle est votre Situation professionnelle ? | EXISTANT |
| `quelle_est_votre_situation_familliale` | Quelle est votre Situation familiale ? | EXISTANT |
| `avez_vous_des_enfant_mineur__` | Avez-vous des Enfants mineurs ? | EXISTANT |
| `domicile__` | Domicile ? | EXISTANT |
| `percevez_vous_` | Percevez-vous ? | EXISTANT |
| `quel_est_votre_lien_avec_le_descendant_francais__` | Quel est votre lien avec le descendant francais ? | NOUVEAU (Ascendant) |
| `avez_vous_fait_votre_scolarite_formation_en_france__` | Avez-vous fait votre scolarite/formation en France ? | NOUVEAU (AES) |
| `quelle_est_votre_situation_professionnel_aes__` | Quelle est votre situation professionnelle (AES) ? | NOUVEAU (AES) |
| `type_dentree_en_france__` | Type d'entree en France | NOUVEAU (AES) |
| `quel_est_votre_lien_avec_le_refugie__` | Quel est votre lien avec le refugie ? | NOUVEAU (TDS/Renouvellement) |
| `vous_etes_entree_en_france_en_tant_que__` | Vous etes entree en France en tant que ? | NOUVEAU (TDS/Renouvellement) |
| `revenu_percu_par_letudiant__` | Revenu percu par l'etudiant ? | NOUVEAU (TDS/Renouvellement) |

---

## Valeurs sous_categorie par onglet

### Ascendant
- `Ascendant`

### AES
- `AES`

### Titre de sejour de Plein droit (8 sous-categories)
- `VPF - Parent d'enfant francais`
- `VPF - Conjoint de Francais`
- `VPF - Membre de famille réfugié`
- `APS - Etudiant`
- `VPF - entré en regroupement famillial`
- `VPF - Jeune majeur arrivées avant 13 ans`
- `AES - jeune majeur - arrivées entre 13 ans et 16ans`
- `TDS - Étudiant`

### Renouvellement (7 sous-categories + 1 ref AES)
- `Renouvellement - carte de résident`
- `Renouvellement - Conjoint de Francais`
- `Renouvellement - Membre de famille réfugié`
- `Renouvellement - entré en regroupement famillial`
- `Renouvellement - Parent d'enfant français`
- `Renouvellement - Jeune majeur arrivées avant 13 ans`
- `Renouvellement - Étudiant`
- *Renouvellement - Parent d'enfant scolarise / Conjoint d'etranger / 10ans / Salarie* -> PAREIL QUE AES

---

## Resume des documents par onglet

| Onglet | Nb documents | Statut |
|---|---|---|
| decret | 110 | EXISTANT |
| naturalisation_mariage | 26 | EXISTANT |
| fraterie | 69 | EXISTANT |
| ascendant | 74 | NOUVEAU |
| aes | 41 | NOUVEAU |
| titre_sejour_plein_droit | 98 | NOUVEAU |
| renouvellement | 85 | NOUVEAU |
| **TOTAL** | **438** (+ onglet "autre") | |

---

## Nouvelles valeurs pour les proprietes de domicile (AES/TDS/Renouvellement)

Les onglets AES, Titre de sejour et Renouvellement utilisent des valeurs de `domicile__` differentes :

| Valeur (anciens onglets) | Valeur (nouveaux onglets) |
|---|---|
| `Propriétaire` | `Je suis propriétaire.` |
| `Locataire` | `Je suis locataire.` |
| `Hébergé(e) à titre gratuit` | `Je suis hébergé par un particulier.` |
| - | `Je suis hébergé à l'hôtel.` |
| - | `Je suis hébergé dans un centre d'hébergement.` |

---

## Nouvelles valeurs pour situation professionnelle AES

Propriete : `quelle_est_votre_situation_professionnel_aes__`

| Valeur |
|---|
| `CDI/CDD/Interimaire` |
| `Métier en tension CDI/CDD` |
| `Sans Emploie` |

---

## Nouvelles valeurs pour type d'entree en France

Propriete : `type_dentree_en_france__`

| Valeur |
|---|
| `Visa court séjour` |
| `Visa long séjour` |
| `Sans visa (entrée irrégulière)` |
| `Titre de séjour délivré dans un autre pays de l'Union Européenne` |

---

## Nouvelles valeurs pour lien avec le refugie

Propriete : `quel_est_votre_lien_avec_le_refugie__`

| Valeur |
|---|
| `Marié` |
| `Enfant` |

---

## Nouvelles valeurs pour entree en France en tant que

Propriete : `vous_etes_entree_en_france_en_tant_que__`

| Valeur |
|---|
| `Marié` |
| `Enfant` |

---

## Nouvelles valeurs pour revenu etudiant

Propriete : `revenu_percu_par_letudiant__`

| Valeur |
|---|
| `J'ai un garant` |
| `Je suis salarié (alternant ok)` |
